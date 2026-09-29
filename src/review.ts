import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Config,configPath,privateDirectory,readConfig,statePath,WdxError} from './core';
import {remote} from './ssh';

const pending='<!-- WERODEX:REVIEW_PENDING -->';
const treeStart='<!-- WERODEX:EXCLUDES:BEGIN -->';
const treeEnd='<!-- WERODEX:EXCLUDES:END -->';
const ignoreStart='# WERODEX:EXCLUDE:BEGIN';
const ignoreEnd='# WERODEX:EXCLUDE:END';
export const treePath=(root:string)=>path.join(root,'.werodex','project-tree.md');
const reviewPath=(root:string)=>path.join(root,'.werodex','review.json');

export function normalizeExclude(input:string){
 const p=input.replace(/\/$/,'');
 if(!p||p==='.gitignore'||p==='.werodex'||p.startsWith('.werodex/')||p==='.git'||p.startsWith('.git/')||p.startsWith('/')||p.startsWith('./')||p.split('/').some(x=>!x||x==='.'||x==='..')||/[\0\r\n\\*?\[\]]/.test(p))throw new WdxError('WDX_PATH','Exclude must be a literal project-relative path');
 return p;
}
function safeRead(file:string){try{const s=fs.lstatSync(file);if(!s.isFile())throw new WdxError('WDX_PATH','Managed file is not a regular file: '+file);return fs.readFileSync(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
function writeText(file:string,content:string,mode=0o600){const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,content,{flag:'wx',mode});fs.renameSync(tmp,file);}catch(e){try{fs.unlinkSync(tmp);}catch{}throw e;}}
function replaceBlock(old:string,start:string,end:string,body:string){const a=old.indexOf(start),b=old.indexOf(end);if((a>=0)!==(b>=0)||(a>=0&&b<a)||old.indexOf(start,a+start.length)>=0||old.indexOf(end,b+end.length)>=0)throw new WdxError('WDX_MANAGED_BLOCK','Malformed managed block');const block=start+'\n'+body+end;if(a<0)return old+(old&&!old.endsWith('\n')?'\n':'')+(old?'\n':'')+block+'\n';return old.slice(0,a)+block+old.slice(b+end.length);}
export function initReview(root:string){privateDirectory(path.join(root,'.werodex'));const f=treePath(root);if(safeRead(f)!==null)throw new WdxError('WDX_REVIEW','Project tree already exists');writeText(f,`# Project tree\n\n${pending}\n\n## Overview\nReplace this line with a bounded, reviewed overview. Use \`werodex tree\` for an initial view.\n\n## Excluded paths\n${treeStart}\n(none)\n${treeEnd}\n`);writeText(reviewPath(root),JSON.stringify({status:'pending'},null,2)+'\n');}
export function isReviewed(root:string){const raw=safeRead(reviewPath(root));if(raw!==null){try{return JSON.parse(raw).status==='complete';}catch{return false;}}try{const x=JSON.parse(fs.readFileSync(statePath(root),'utf8'));return Number(x.version)>0&&!!x.lastSync;}catch{return false;}}
export function assertReviewed(root:string){if(!isReviewed(root))throw new WdxError('WDX_REVIEW_REQUIRED','Review .werodex/project-tree.md, mark data/output paths with werodex exclude add, then run werodex review complete before syncing');}
export function completeReview(root:string){const content=safeRead(treePath(root));if(!content||content.includes(pending)||!content.includes('## Overview')||!/## Overview\s*\n(?:(?!## Excluded paths)[\s\S])*?\S/.test(content)||content.includes('Replace this line with a bounded, reviewed overview'))throw new WdxError('WDX_REVIEW','Complete the project tree overview and remove the pending marker first');writeText(reviewPath(root),JSON.stringify({status:'complete',completed:new Date().toISOString()},null,2)+'\n');}
export function boundedTree(root:string,relative='',depth=2,perDirectory=40,totalLimit=200){
 const base=relative?normalizeExclude(relative):'';let at=root;
 for(const part of base.split('/').filter(Boolean)){at=path.join(at,part);const s=fs.lstatSync(at);if(!s.isDirectory())throw new WdxError('WDX_PATH','Tree path is not a directory: '+relative);}
 const lines=[base||'.'];let total=0;
 function walk(dir:string,level:number){if(level>=depth||total>=totalLimit)return;const d=fs.opendirSync(dir);const entries:fs.Dirent[]=[];let extra=false;try{for(let i=0;i<=perDirectory;i++){const x=d.readSync();if(!x)break;if(i===perDirectory){extra=true;break;}entries.push(x);}}finally{d.closeSync();}
  entries.sort((a,b)=>a.name.localeCompare(b.name));for(const x of entries){if(total>=totalLimit){lines.push('  '.repeat(level+1)+'… total display limit reached');return;}total++;const tag=x.isSymbolicLink()?' [symlink]':x.isDirectory()?' /':'';lines.push('  '.repeat(level+1)+x.name+tag);if(x.isDirectory()&&!['.git','.werodex','node_modules','datasets','data','pretrained','checkpoints','outputs','wandb','runs','artifacts','artifact'].includes(x.name))walk(path.join(dir,x.name),level+1);}
  if(extra)lines.push('  '.repeat(level+1)+`… more than ${perDirectory} entries; inspect this directory separately`);
 }
 walk(at,0);return lines.join('\n')+'\n';
}
function gitPattern(p:string){return '/'+p.replace(/[ #!]/g,x=>'\\'+x);}
export function updateExclude(root:string,action:'add'|'remove',input:string,reason=''){
 const p=normalizeExclude(input),c=readConfig(root);if(action==='add'&&(/[\r\n]/.test(reason)||reason.length>500||reason.includes(treeStart)||reason.includes(treeEnd)))throw new WdxError('WDX_USAGE','Reason must be a short single line');if(action==='add'&&!reason.trim())throw new WdxError('WDX_USAGE','exclude add requires --reason');
 const gitFile=path.join(root,'.gitignore'),treeFile=treePath(root),oldGit=safeRead(gitFile),oldTree=safeRead(treeFile);if(oldTree===null&&!isReviewed(root))throw new WdxError('WDX_REVIEW','Project tree missing');const treeBase=oldTree??`# Project tree\n\n## Overview\nLegacy workspace; inspect with werodex tree and update this overview.\n\n## Excluded paths\n${treeStart}\n(none)\n${treeEnd}\n`;
 const paths=new Set(c.sync.exclude??[]),notes={...(c.sync.excludeReasons??{})};if(action==='add'){paths.add(p);notes[p]=reason.trim();}else{paths.delete(p);delete notes[p];}
 const sorted=[...paths].sort();c.sync.exclude=sorted;c.sync.excludeReasons=notes;
 const git=replaceBlock(oldGit??'',ignoreStart,ignoreEnd,sorted.map(x=>gitPattern(x)+'\n').join(''));
 const tree=replaceBlock(treeBase,treeStart,treeEnd,sorted.length?sorted.map(x=>`- \`${x.replaceAll('`','\\`')}\`: ${notes[x]??'Excluded'}\n`).join(''):'(none)\n');
 const entries=[{file:configPath(root),old:safeRead(configPath(root)),next:JSON.stringify(c,null,2)+'\n',mode:0o600},{file:gitFile,old:oldGit,next:git,mode:oldGit===null?0o644:(fs.lstatSync(gitFile).mode&0o777)},{file:treeFile,old:oldTree,next:tree,mode:0o600}];
 const changed:typeof entries=[];try{for(const x of entries){writeText(x.file,x.next,x.mode);changed.push(x);}}catch(e){let rollbackError:unknown;for(const x of changed.reverse())try{if(x.old===null)fs.unlinkSync(x.file);else writeText(x.file,x.old,x.mode);}catch(err){rollbackError=err;}if(rollbackError)throw new WdxError('WDX_EXCLUDE','Update failed and rollback was incomplete: '+String(rollbackError));throw e;}
 return {path:p,action,exclude:sorted};
}
export function listExcludes(c:Config){return (c.sync.exclude??[]).map(p=>({path:p,reason:c.sync.excludeReasons?.[p]??''}));}


type RemoteIgnore={content:string|null;hash:string|null;mode:string};
function managedIgnoreBody(content:string|null){
 if(content===null)return null;
 const a=content.indexOf(ignoreStart),b=content.indexOf(ignoreEnd);
 if((a<0)!==(b<0)||b<a||content.indexOf(ignoreStart,a+ignoreStart.length)>=0||content.indexOf(ignoreEnd,b+ignoreEnd.length)>=0)throw new WdxError('WDX_MANAGED_BLOCK','Malformed .gitignore managed block');
 return a<0?null:content.slice(a,b+ignoreEnd.length);
}
function expectedIgnoreBlock(c:Config){return ignoreStart+'\n'+[...(c.sync.exclude??[])].sort().map(x=>gitPattern(x)+'\n').join('')+ignoreEnd;}
async function readRemoteIgnore(c:Config):Promise<RemoteIgnore>{
 const script='set -e\ncd "$1"\n[[ ! -L .gitignore ]] || exit 9\nif [[ -e .gitignore ]]; then [[ -f .gitignore ]] || exit 9; printf "E %s %s\\n" "$(stat -c %a -- .gitignore)" "$(sha256sum -- .gitignore | cut -d " " -f 1)"; base64 -w0 -- .gitignore; else printf "N\\n"; fi';
 const r=await remote(c,script,[c.remote.project],60000,2*1024*1024);
 if(r.code)throw new WdxError('WDX_GITIGNORE',r.stderr||'Cannot read remote .gitignore');
 const i=r.stdout.indexOf('\n'),head=r.stdout.slice(0,i),body=r.stdout.slice(i+1);
 if(head==='N')return {content:null,hash:null,mode:'644'};
 const m=/^E ([0-7]{3,4}) ([a-f0-9]{64})$/.exec(head);
 if(!m)throw new WdxError('WDX_GITIGNORE','Invalid remote .gitignore metadata');
 const content=Buffer.from(body,'base64').toString('utf8');
 if(createHash('sha256').update(content).digest('hex')!==m[2])throw new WdxError('WDX_GITIGNORE','Remote .gitignore changed while reading');
 return {content,hash:m[2],mode:m[1]};
}
async function writeRemoteIgnore(c:Config,old:RemoteIgnore,next:string){
 const encoded=Buffer.from(next).toString('base64'),tmp='.gitignore.werodex-'+randomUUID()+'.tmp';
 const pre=old.hash?`[[ -f .gitignore && ! -L .gitignore && "$(sha256sum -- .gitignore | cut -d ' ' -f 1)" = ${JSON.stringify(old.hash)} ]] || exit 8`:'[[ ! -e .gitignore && ! -L .gitignore ]] || exit 8';
 const script=`set -e\ncd "$1"\n${pre}\ntrap 'rm -f -- "$2"' EXIT\nprintf %s "$3" | base64 -d > "$2"\nchmod ${old.mode} -- "$2"\nmv -T -- "$2" .gitignore\n`;
 const r=await remote(c,script,[c.remote.project,tmp,encoded]);
 if(r.code)throw new WdxError('WDX_GITIGNORE',r.code===8?'Remote .gitignore changed; retry the exclude command':r.stderr||'Cannot update remote .gitignore');
}
export function ensureLocalManagedIgnore(root:string,remoteSeed=''){
 const file=path.join(root,'.gitignore'),old=safeRead(file),next=replaceBlock(old??remoteSeed,ignoreStart,ignoreEnd,'');
 writeText(file,next,old===null?0o644:(fs.lstatSync(file).mode&0o777));
}
export async function ensureRemoteManagedIgnore(c:Config){
 const old=await readRemoteIgnore(c),next=replaceBlock(old.content??'',ignoreStart,ignoreEnd,[...(c.sync.exclude??[])].sort().map(x=>gitPattern(x)+'\n').join(''));
 if(next!==old.content)await writeRemoteIgnore(c,old,next);
 return next;
}
export async function assertManagedIgnoreConsistent(root:string,c:Config){
 const local=managedIgnoreBody(safeRead(path.join(root,'.gitignore'))),rem=managedIgnoreBody((await readRemoteIgnore(c)).content),expected=expectedIgnoreBlock(c);
 if((local===null&&rem===null&&!(c.sync.exclude??[]).length))return;
 if(local!==expected||rem!==expected)throw new WdxError('WDX_EXCLUDE_DIVERGED','Werodex .gitignore blocks differ from sync.exclude; retry exclude add/remove before sync');
}
export async function updateExcludeBoth(root:string,c:Config,action:'add'|'remove',input:string,reason=''){
 const files=[configPath(root),path.join(root,'.gitignore'),treePath(root)];
 const old=files.map(file=>({file,content:safeRead(file),mode:fs.existsSync(file)?fs.lstatSync(file).mode&0o777:0o600}));
 const previousRemote=await readRemoteIgnore(c);
 let result:ReturnType<typeof updateExclude>;let attemptedBlock:string|null=null;
 try{
  result=updateExclude(root,action,input,reason);
  attemptedBlock=expectedIgnoreBlock(readConfig(root));
  await ensureRemoteManagedIgnore(readConfig(root));
  return result;
 }catch(error){
  for(const x of old.reverse()){
   if(x.content===null){try{fs.unlinkSync(x.file);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
   else writeText(x.file,x.content,x.mode);
  }
  const current=await readRemoteIgnore(c).catch(()=>null);
  if(current&&attemptedBlock&&managedIgnoreBody(current.content)===attemptedBlock&&managedIgnoreBody(previousRemote.content)!==attemptedBlock){
   try{const oldConfig=readConfig(root),restored=replaceBlock(current.content??'',ignoreStart,ignoreEnd,[...(oldConfig.sync.exclude??[])].sort().map(x=>gitPattern(x)+'\n').join(''));await writeRemoteIgnore(c,current,restored);}catch{throw new WdxError('WDX_EXCLUDE','Exclude update failed; remote rollback also failed. Reconcile the managed .gitignore blocks before sync');}
  }
  throw error;
 }
}
