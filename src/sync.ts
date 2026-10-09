import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Config,atomicJson,statePath,WdxError,run,shQuote} from './core';
import {PathPolicyEngine} from './policy';
import {remote,effective,controlPath,rsyncSsh,gitState,assertRemoteGit,remoteAction} from './ssh';
import {localGitRoot,gitBoundaryScript,assertGitResult} from './git';
import {withLease,withTransferLease} from './daemon';
import {assertReviewed,assertManagedIgnoreConsistent} from './review';
export type Entry={size:number;hash:string};
export type Manifest={version:number;files:Record<string,Entry & {baselineVersion:number}>;localHead:string|null;remoteHead:string|null;lastSync:string};
export type Conflict={path:string;base:Entry|null;local:Entry|null;remote:Entry|null};
export type Report={id:string;created:string;manifestVersion:number;direction:'sync'|'pull';conflicts:Conflict[];git:Awaited<ReturnType<typeof gitState>>;baseline:Manifest};
const empty=():Manifest=>({version:0,files:{},localHead:null,remoteHead:null,lastSync:''});
export function readManifest(root:string):Manifest{try{return JSON.parse(fs.readFileSync(statePath(root),'utf8'));}catch{return empty();}}
const reportFile=(root:string,id:string)=>path.join(root,'.werodex','conflicts',id,'report.json');
export function readReport(root:string,id:string):Report{if(!/^[a-f0-9-]{36}$/.test(id))throw new WdxError('WDX_CONFLICT','Invalid conflict ID');try{const x=JSON.parse(fs.readFileSync(reportFile(root,id),'utf8')) as Report;if(x.id!==id||!Array.isArray(x.conflicts)||x.conflicts.some(c=>!c.path||path.posix.isAbsolute(c.path)||c.path.split('/').includes('..')||PathPolicyEngine.isNeverSource(c.path)))throw new Error('unsafe report');return x;}catch{throw new WdxError('WDX_CONFLICT','Conflict report missing or invalid');}}
export async function remoteInventory(c:Config,skippedLarge:{path:string;size:number}[]=[],options:{paths?:string[];full?:boolean}={}):Promise<Map<string,Entry>>{
 const result=await remoteAction(c,'scan',options,{timeout:120000});const output=new Map<string,Entry>();
 for(const file of result.value.files)output.set(file.path,{size:file.size,hash:file.hash});skippedLarge.push(...result.value.skippedLarge);return output;
}
function compare(a:Entry|null,b:Entry|null){return a?.hash===b?.hash&&a?.size===b?.size;}
export function nextManifestFiles(local:Map<string,Entry>,rem:Map<string,Entry>,base:Manifest):Manifest['files']{
 const files:Manifest['files']=Object.create(null);
 for(const p of new Set([...Object.keys(base.files),...local.keys(),...rem.keys()])){
  if(PathPolicyEngine.isNeverSource(p))continue;
  const l=local.get(p),r=rem.get(p);
  if(l&&r&&compare(l,r))files[p]={...l,baselineVersion:base.version+1};
  else if(base.files[p]&&(l||r))files[p]=base.files[p];
 }
 return files;
}
async function copyFiles(c:Config,root:string,direction:'sync'|'pull',files:string[]){
 if(!files.length)return;
 for(const p of files){if(PathPolicyEngine.isNeverSource(p))throw new WdxError('WDX_TRANSFER_POLICY','Transfer blocked by Werodex policy: '+p);PathPolicyEngine.assertSafeTransferPath(root,p);}
 let script=`set -e\nproject="\${1%/}"\n[[ "$(realpath -e -- "$project")" = "$project" ]] || { echo unsafe-remote-project >&2; exit 9; }\n${gitBoundaryScript()}`;
 for(const p of files)script+=`p=${shQuote(p)}\nfull="$project/$p"\n[[ "$(realpath -m -- "$full")" = "$full" ]] || { echo "Remote transfer path resolves through a symlink: $p" >&2; exit 9; }\n[[ ! -e "$full" || -f "$full" ]] || { echo "Remote transfer destination is not a regular file: $p" >&2; exit 9; }\n`;
 const check=await remote(c,script,[c.remote.project]);
 assertGitResult(check,'WDX_PATH');
 await withTransferLease(c,async sock=>{
 const base=c.remote.target+':'+c.remote.project+'/';
 const args=['-s','-a','--no-links','--no-devices','--no-specials','--no-perms','--from0','--files-from=-','-e',rsyncSsh(sock),'--'];
 if(direction==='sync')args.push(root+'/',base);else args.push(base,root+'/');
 const r=await run('rsync',args,{input:files.join('\0')+'\0',timeout:180000,maxBytes:2*1024*1024});
 if(r.code)throw new WdxError('WDX_RSYNC',r.stderr||r.stdout);
 });
}
export function computeChanges(local:Map<string,Entry>,rem:Map<string,Entry>,base:Manifest,direction:'sync'|'pull'){const paths=new Set([...local.keys(),...rem.keys()]);const conflicts:Conflict[]=[];const transfer:string[]=[];for(const p of paths){const l=local.get(p)??null,r=rem.get(p)??null,b=base.files[p]??null;if(compare(l,r))continue;const lc=!compare(l,b),rc=!compare(r,b);if(l&&r&&lc&&rc){conflicts.push({path:p,base:b,local:l,remote:r});continue;}if(direction==='sync'&&l&&(lc||!r))transfer.push(p);if(direction==='pull'&&r&&(rc||!l))transfer.push(p);}return {conflicts,transfer};}
function createReport(root:string,direction:'sync'|'pull',conflicts:Conflict[],baseline:Manifest,git:Report['git']){const id=randomUUID(),report:Report={id,created:new Date().toISOString(),manifestVersion:baseline.version,direction,conflicts,git,baseline};atomicJson(reportFile(root,id),report);return report;}
export function validateReport(root:string,report:Report,baseline:Manifest,rem:Map<string,Entry>,git:Report['git']){if(baseline.version!==report.manifestVersion||git.remoteHead!==report.git.remoteHead||git.remoteDirty!==report.git.remoteDirty)throw new WdxError('WDX_CONFLICT_STALE','Conflict report is stale');for(const c of report.conflicts)if(!compare(c.remote,rem.get(c.path)??null))throw new WdxError('WDX_CONFLICT_STALE','Remote conflict file changed: '+c.path);}
async function backupRemote(c:Config,report:Report){
 const dir=`$HOME/.local/state/werodex/backups/${c.workspaceId}/${report.id}`;
 let script=`set -e\nproject="$1"\n[[ "$(realpath -e -- "$project")" = "$project" ]] || { echo unsafe-remote-project >&2; exit 9; }\ncd "$project"\n${gitBoundaryScript()}d=${shQuote(dir)}\neval "d=$d"\nmkdir -p -- "$d"\nchmod 700 -- "$d"\n`;
 for(const conflict of report.conflicts){
  if(!conflict.remote)throw new WdxError('WDX_BACKUP','Conflict has no remote file: '+conflict.path);
  script+=`p=${shQuote(conflict.path)}\n[[ "$(realpath -m -- "$project/$p")" = "$project/$p" ]] || { echo "Remote conflict path resolves through a symlink: $p" >&2; exit 9; }\n[[ -f "$p" && ! -L "$p" ]] || { echo "Remote conflict file missing: $p" >&2; exit 9; }\n[[ "$(stat -c%s -- "$p")" = ${shQuote(String(conflict.remote.size))} ]] || { echo "Remote conflict size changed: $p" >&2; exit 9; }\nread -r hash _ < <(sha256sum -- "$p")\n[[ "$hash" = ${shQuote(conflict.remote.hash)} ]] || { echo "Remote conflict hash changed: $p" >&2; exit 9; }\nmkdir -p -- "$d/$(dirname -- "$p")"\ncp -p --remove-destination -- "$p" "$d/$p"\nread -r hash _ < <(sha256sum -- "$d/$p")\n[[ "$hash" = ${shQuote(conflict.remote.hash)} ]] || { echo "Remote backup hash mismatch: $p" >&2; exit 9; }\n`;
 }
 const metadata=Buffer.from(JSON.stringify(report)).toString('base64');
 script+=`printf %s ${shQuote(metadata)} | base64 -d > "$d/report.json.tmp"\nmv -- "$d/report.json.tmp" "$d/report.json"\n`;
 const r=await remote(c,script,[c.remote.project]);
 if(r.code)throw new WdxError('WDX_BACKUP',r.stderr||'Remote backup failed');
 return dir;
}
export function backupLocal(root:string,report:Report){
 const dir=path.join(root,'.werodex','conflicts',report.id,'local');
 for(const x of report.conflicts){PathPolicyEngine.assertSafeTransferPath(root,x.path);const src=path.join(root,x.path);if(!fs.existsSync(src)||!fs.lstatSync(src).isFile())throw new WdxError('WDX_BACKUP','Conflict source is no longer a regular file: '+x.path);}
 for(const x of report.conflicts){const src=path.join(root,x.path),dst=path.join(dir,x.path);fs.mkdirSync(path.dirname(dst),{recursive:true,mode:0o700});fs.copyFileSync(src,dst);}
 return dir;
}
export async function sync(c:Config,root:string,direction:'sync'|'pull',opts:{resolve?:string;keepLocal?:string;keepRemote?:string;allowLarge?:boolean;paths?:string[];full?:boolean}={}){assertReviewed(root);await localGitRoot(root);return withLease(c,async()=>{await assertRemoteGit(c);await assertManagedIgnoreConsistent(root,c);const effectiveConfig=opts.allowLarge?{...c,sync:{...c.sync,maxSourceFileMB:1024*1024}}:c;const policy=new PathPolicyEngine(root,effectiveConfig),local=await policy.sourceFiles({paths:opts.paths,full:opts.full}),remoteSkipped:{path:string;size:number}[]=[],rem=await remoteInventory(effectiveConfig,remoteSkipped,{paths:opts.paths,full:opts.full}),base=readManifest(root),git=await gitState(c,root);let report:Report|undefined;
 if(opts.resolve||opts.keepLocal||opts.keepRemote){const id=opts.resolve??opts.keepLocal??opts.keepRemote!;report=readReport(root,id);validateReport(root,report,base,rem,git);}
 const {conflicts,transfer}=computeChanges(local,rem,base,direction);const remoteWins:string[]=[];const initialSkippedLocal=[...policy.skippedLarge];
 // A missing inventory entry may be ignored or oversized, not absent. Check
 // both endpoint policies for the whole batch before any backup or transfer.
 const candidates=[...new Set([...transfer,...(report?.conflicts.map(x=>x.path)??[])])];
 if(candidates.length){
  await policy.assertTransferAllowed(candidates);
  const allowed=await remote(c,PathPolicyEngine.remoteTransferCheckScript(candidates,effectiveConfig),[c.remote.project]);
  if(allowed.code)throw new WdxError('WDX_TRANSFER_POLICY',allowed.stderr||'Remote transfer policy check failed');
 }

 if(conflicts.length&&!report){const created=createReport(root,direction,conflicts,base,git);const staged=path.join(root,'.werodex','conflicts',created.id,'remote');fs.mkdirSync(staged,{recursive:true,mode:0o700});let stageWarning='';try{await copyFiles(c,staged,'pull',conflicts.filter(x=>x.remote).map(x=>x.path));}catch(e){stageWarning=' Remote copies unavailable: '+(e as Error).message;}throw new WdxError('WDX_CONFLICT',`Conflict ${created.id}: ${conflicts.map(x=>x.path).join(', ')}. Inspect .werodex/conflicts/${created.id}/report.json; merge, then werodex sync --resolve ${created.id}, or use --keep-local/--keep-remote ${created.id}.${stageWarning}`);}
 if(report){const old=new Set(report.conflicts.map(x=>x.path));if(conflicts.some(x=>!old.has(x.path)))throw new WdxError('WDX_CONFLICT_STALE','New conflicts appeared');if(opts.keepLocal){await backupRemote(c,report);transfer.push(...report.conflicts.map(x=>x.path).filter(x=>local.has(x)));direction='sync';}else if(opts.keepRemote){backupLocal(root,report);remoteWins.push(...report.conflicts.map(x=>x.path).filter(x=>rem.has(x)));}else{for(const x of report.conflicts){const now=local.get(x.path);if(!now||compare(now,x.local))throw new WdxError('WDX_CONFLICT_UNRESOLVED','Local merge has not changed '+x.path+'; choose an explicit keep strategy if intentional');}transfer.push(...report.conflicts.map(x=>x.path).filter(x=>local.has(x)));direction='sync';}}
 const transferPaths=[...new Set(transfer)],remoteWinPaths=[...new Set(remoteWins)];
 if(transferPaths.length||remoteWinPaths.length){
  const freshLocal=await policy.sourceFiles({paths:[...new Set([...transferPaths,...remoteWinPaths])],full:true}),freshRemote=await remoteInventory(effectiveConfig,[],{paths:[...new Set([...transferPaths,...remoteWinPaths])],full:true});
  for(const p of new Set([...transferPaths,...remoteWinPaths]))if(!compare(freshLocal.get(p)??null,local.get(p)??null)||!compare(freshRemote.get(p)??null,rem.get(p)??null))throw new WdxError('WDX_CONCURRENT_CHANGE','Source changed during sync preparation: '+p);
 }
 await copyFiles(c,root,'pull',remoteWinPaths);await copyFiles(c,root,direction,transferPaths);const skippedLarge=[...initialSkippedLocal.map(x=>({...x,side:'local'})),...remoteSkipped.map(x=>({...x,side:'remote'}))];const verifyPaths=[...new Set([...transferPaths,...remoteWinPaths])];const afterLocal=new Map(local),afterRemote=new Map(rem);if(verifyPaths.length){const verifiedLocal=await policy.sourceFiles({paths:verifyPaths,full:true}),verifiedRemote=await remoteInventory(effectiveConfig,[],{paths:verifyPaths,full:true});for(const p of verifyPaths){afterLocal.delete(p);afterRemote.delete(p);if(verifiedLocal.has(p))afterLocal.set(p,verifiedLocal.get(p)!);if(verifiedRemote.has(p))afterRemote.set(p,verifiedRemote.get(p)!);}}
 for(const p of new Set([...transferPaths,...remoteWinPaths]))if(!afterLocal.has(p)||!afterRemote.has(p)||!compare(afterLocal.get(p)!,afterRemote.get(p)!))throw new WdxError('WDX_CONCURRENT_CHANGE','Transferred Source did not converge: '+p);
 const files=opts.paths?{...Object.fromEntries(Object.entries(base.files).filter(([p])=>!opts.paths!.includes(p)&&!PathPolicyEngine.isNeverSource(p))),...nextManifestFiles(afterLocal,afterRemote,{...base,files:Object.fromEntries(Object.entries(base.files).filter(([p])=>opts.paths!.includes(p)))})}:nextManifestFiles(afterLocal,afterRemote,base);atomicJson(statePath(root),{version:base.version+1,files,localHead:git.localHead,remoteHead:git.remoteHead,lastSync:new Date().toISOString()});return {transferred:transfer.length+remoteWins.length,manifestVersion:base.version+1,skippedLarge};});}
export async function restoreConflict(c:Config,root:string,id:string,side:'local'|'remote'){
 const report=readReport(root,id);
 await localGitRoot(root);
 if(side==='remote')await assertRemoteGit(c);
 if(side==='local'){
  const pairs=report.conflicts.map(x=>({src:path.join(root,'.werodex','conflicts',id,'local',x.path),dst:path.join(root,x.path)}));
  for(const x of report.conflicts)PathPolicyEngine.assertSafeTransferPath(root,x.path);for(const {src} of pairs)if(!fs.existsSync(src)||!fs.lstatSync(src).isFile())throw new WdxError('WDX_RESTORE','Local backup missing or unsafe: '+src);for(const x of report.conflicts)PathPolicyEngine.assertSafeTransferPath(path.join(root,'.werodex','conflicts',id,'local'),x.path);
  for(const {src,dst} of pairs){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);}
  return;
 }
 const d=`$HOME/.local/state/werodex/backups/${c.workspaceId}/${id}`;
 let script=`set -e\nproject="$1"\n[[ "$(realpath -e -- "$project")" = "$project" ]] || { echo unsafe-remote-project >&2; exit 9; }\ncd "$project"\n${gitBoundaryScript()}d=${shQuote(d)}\neval "d=$d"\ntest -d "$d" || { echo "Remote backup missing" >&2; exit 9; }\n`;
 for(const x of report.conflicts){
  if(!x.remote)throw new WdxError('WDX_RESTORE','Conflict has no remote file: '+x.path);
  script+=`p=${shQuote(x.path)}\n[[ "$(realpath -m -- "$project/$p")" = "$project/$p" ]] || { echo "Remote restore path resolves through a symlink: $p" >&2; exit 9; }\n[[ "$(realpath -m -- "$d/$p")" = "$d/$p" ]] || { echo "Remote backup path resolves through a symlink: $p" >&2; exit 9; }\n[[ -f "$d/$p" && ! -L "$d/$p" ]] || { echo "Remote backup file missing: $p" >&2; exit 9; }\nread -r hash _ < <(sha256sum -- "$d/$p")\n[[ "$hash" = ${shQuote(x.remote.hash)} ]] || { echo "Remote backup hash mismatch: $p" >&2; exit 9; }\n`;
 }
 for(const x of report.conflicts)script+=`p=${shQuote(x.path)}\nmkdir -p -- "$(dirname -- "$p")"\ncp -p -- "$d/$p" "$p"\n`;
 const r=await remote(c,script,[c.remote.project]);
 assertGitResult(r,'WDX_RESTORE');
}
export async function diff(c:Config,root:string){return withLease(c,async()=>{const l=await new PathPolicyEngine(root,c).sourceFiles(),r=await remoteInventory(c),all=new Set([...l.keys(),...r.keys()]);return [...all].filter(p=>!compare(l.get(p)??null,r.get(p)??null)).map(p=>({path:p,local:l.get(p)??null,remote:r.get(p)??null}));});}
