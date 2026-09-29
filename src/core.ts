import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export class WdxError extends Error { constructor(public code: string, message: string) { super(message); } }
export type Config = {version: 1; workspaceId: string; remote: {target: string; project: string}; ssh: {credentialRef?: string}; sync: {delete: false; maxSourceFileMB: number; exclude?: string[]; excludeReasons?: Record<string,string>}; runtime: {tmp: string; maxChannels: number; maxLogSizeMB: number; logRetentionDays: number};};
export const protectedNames = ['datasets','data','pretrained','checkpoints','outputs','wandb','runs','artifacts','artifact'];
export const defaultConfig = (target: string, project: string): Config => ({version:1,workspaceId:randomUUID(),remote:{target,project},ssh:{},sync:{delete:false,maxSourceFileMB:32},runtime:{tmp:'/tmp/werodex',maxChannels:4,maxLogSizeMB:256,logRetentionDays:7}});
export function assertWorkspace(root: string): string {
  const real = fs.realpathSync(root); const home = fs.realpathSync(os.homedir());
  if (real === '/' || real === home || real === '/root' || ['/tmp','/var','/usr','/opt','/mnt','/etc','/home'].includes(real) || real.split('/').filter(Boolean).length < 2) throw new WdxError('WDX_UNSAFE_WORKSPACE',`Unsafe workspace: ${real}`);
  return real;
}
export function configPath(root: string) { return path.join(root,'.werodex','config.json'); }
export function statePath(root: string) { return path.join(root,'.werodex','state.json'); }
export function privateDirectory(dir:string,create=true){
 if(!path.isAbsolute(dir))throw new WdxError('WDX_PRIVATE_DIR','Private state directory must be absolute');
 let stat:fs.Stats;
 try{stat=fs.lstatSync(dir);}catch(e){if(!create||(e as NodeJS.ErrnoException).code!=='ENOENT')throw e;fs.mkdirSync(dir,{recursive:true,mode:0o700});stat=fs.lstatSync(dir);}
 if(!stat.isDirectory()||stat.uid!==(process.getuid?.()??-1)||(stat.mode&0o777)!==0o700)throw new WdxError('WDX_PRIVATE_DIR','Private state directory must be owned by this UID, mode 0700, and not a symlink: '+dir);
 return dir;
}
export function atomicJson(file: string, value: unknown, mode=0o600) {
 privateDirectory(path.dirname(file));
 const tmp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
 try{fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode,flag:'wx'});fs.renameSync(tmp,file);}catch(e){try{fs.unlinkSync(tmp);}catch{}throw e;}
}
export function readConfig(root: string): Config {
  let x: any; try { x=JSON.parse(fs.readFileSync(configPath(root),'utf8')); } catch { throw new WdxError('WDX_CONFIG_MISSING','Run werodex init first.'); }
  if (x?.version!==1 || typeof x.workspaceId!=='string' || !x.workspaceId || typeof x.remote?.target!=='string' || !x.remote.target || typeof x.remote?.project!=='string' || !x.remote.project.startsWith('/') || x.sync?.delete!==false || !Number.isFinite(x.sync?.maxSourceFileMB) || x.sync.maxSourceFileMB<=0 || (!x.ssh || typeof x.ssh!=='object' || Array.isArray(x.ssh) || Object.keys(x.ssh).some(k=>k!=='credentialRef')) || (x.ssh.credentialRef!==undefined && (typeof x.ssh.credentialRef!=='string'||!x.ssh.credentialRef))) throw new WdxError('WDX_CONFIG_INVALID','Invalid workspace config or forbidden credential field.');
  if (JSON.stringify(x).match(/"(?:password|token|secret|privateKey|apiKey)"\s*:/i)) throw new WdxError('WDX_CONFIG_SECRET','Secrets cannot be stored in workspace config.');
  if(!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(x.remote.target)||/[\n\r\0]/.test(x.remote.project)||x.remote.project.split('/').includes('..')||path.posix.normalize(x.remote.project)!==x.remote.project.replace(/\/$/,'')||['/','/root','/tmp','/home','/var','/usr','/opt','/mnt'].includes(x.remote.project.replace(/\/$/,''))||!/^[A-Za-z0-9-]+$/.test(x.workspaceId)||!Array.isArray(x.sync.exclude??[])||(x.sync.exclude??[]).some((p:unknown)=>typeof p!=='string'||!p||p.startsWith('/')||p.replace(/\/$/,'').split('/').some((part:string)=>!part||part==='.'||part==='..')||/[\n\r\0\\*?\[\]]/.test(p))||(x.sync.excludeReasons!==undefined&&(typeof x.sync.excludeReasons!=='object'||x.sync.excludeReasons===null||Array.isArray(x.sync.excludeReasons)||Object.entries(x.sync.excludeReasons).some(([k,v])=>typeof v!=='string'||!(x.sync.exclude??[]).includes(k))))){throw new WdxError('WDX_CONFIG_INVALID','Unsafe target, workspace ID, or exclude path');}x.runtime ??= defaultConfig(x.remote.target,x.remote.project).runtime;if(typeof x.runtime.tmp!=='string'||!path.posix.isAbsolute(x.runtime.tmp)||x.runtime.tmp.split('/').includes('..')||/[\n\r\0]/.test(x.runtime.tmp)||!Number.isInteger(x.runtime.maxChannels)||x.runtime.maxChannels<1||x.runtime.maxChannels>16||!Number.isFinite(x.runtime.maxLogSizeMB)||x.runtime.maxLogSizeMB<1||!Number.isInteger(x.runtime.logRetentionDays)||x.runtime.logRetentionDays<1)throw new WdxError('WDX_CONFIG_INVALID','Invalid runtime limits');
  return x as Config;
}
export type Result = {code:number; stdout:string; stderr:string};
export function run(file:string,args:string[],options:{cwd?:string;input?:string;timeout?:number;env?:NodeJS.ProcessEnv;maxBytes?:number}={}):Promise<Result>{
  return new Promise((resolve,reject)=>{ const p=spawn(file,args,{cwd:options.cwd,env:options.env??process.env,stdio:['pipe','pipe','pipe']}); let out=''; let err=''; const max=options.maxBytes??8*1024*1024; const timer=options.timeout?setTimeout(()=>p.kill('SIGKILL'),options.timeout):undefined;
    p.stdout.on('data',(b:Buffer)=>{out+=b.toString(); if(out.length>max){p.kill('SIGKILL');err+='\noutput limit exceeded';}}); p.stderr.on('data',(b:Buffer)=>{err+=b.toString(); if(err.length>max)p.kill('SIGKILL');}); p.on('error',reject); p.on('close',code=>{if(timer)clearTimeout(timer);resolve({code:code??1,stdout:out,stderr:err});}); p.stdin.end(options.input);
  });
}
export function shQuote(s:string){return "'"+s.replace(/'/g,"'\\''")+"'";}
export function managedAgents(root:string){ const file=path.join(root,'AGENTS.md'); let existing:fs.Stats|undefined;try{existing=fs.lstatSync(file);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(existing&&!existing.isFile())throw new WdxError('WDX_AGENTS_INVALID','AGENTS.md must be a regular file'); const start='<!-- WERODEX:BEGIN -->'; const end='<!-- WERODEX:END -->'; const block=`${start}\nRemote operations use werodex; do not invoke ssh, scp, or rsync directly.\nBefore the first sync or pull, run werodex tree for a bounded two-level view (up to 40 entries per directory), complete .werodex/project-tree.md, mark data/output paths with werodex exclude add PATH --reason TEXT, then run werodex review complete.\nMaintain the project tree as work proceeds. Before running a download script, download command, or a job that generates substantial outputs, inspect its destination and add exclusions before execution. Update the tree when datasets or artifacts change.\nEdit local Source, then run werodex sync. Dataset, output, checkpoint, and pretrained paths are remote-only. Do not recursively inspect them.\nUse werodex run --detach for long jobs, wait instead of polling, status for state, and bounded logs before --raw. Do not use attach or shell by default.\nUse the workspace runtime.tmp setting when choosing temporary output paths; Werodex does not change TMPDIR automatically. After completing and verifying a feature that changes remote Source, sync and run werodex checkpoint -m MESSAGE -- PATH... for only its changed remote Source files; local Git commits are not required. Then run werodex git-tree. For every completed feature or local-only deliverable, write a concise entry under .werodex/ and call werodex log add --file ENTRY.md, naming only necessary small remote assets.\nIf the user asks for a document or report only on the local machine, run werodex exclude add PATH --reason "local-only: ..." before creating it.\nIf sync reports a conflict, inspect the Conflict Report, merge locally, then run werodex sync --resolve <id>.\n${end}`; const old=existing?fs.readFileSync(file,'utf8'):''; const a=old.indexOf(start),b=old.indexOf(end); if((a>=0)!==(b>=0) || (a>=0&&b<a))throw new WdxError('WDX_AGENTS_INVALID','Malformed Werodex block in AGENTS.md'); const next=a>=0?old.slice(0,a)+block+old.slice(b+end.length):old+(old&&!old.endsWith('\n')?'\n':'')+'\n'+block+'\n'; const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,next,{flag:'wx',mode:existing?(existing.mode&0o777):0o644});fs.renameSync(tmp,file);}catch(e){try{fs.unlinkSync(tmp);}catch{}throw e;} }
export function ensureLinux(){if(process.platform!=='linux')throw new WdxError('WDX_PLATFORM','Werodex V1 supports Linux only.');}
