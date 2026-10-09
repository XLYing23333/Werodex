import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {Config,run,shQuote,WdxError,Result,privateDirectory} from './core';
import {localGitRoot,gitBoundaryScript,assertGitResult} from './git';
import {PathPolicyEngine} from './policy';
export async function assertRemoteGit(config:Config,allowMissing=false){const r=await remote(config,'set -e\n'+gitBoundaryScript(allowMissing),[config.remote.project]);assertGitResult(r);return r.stdout;}
export type Effective={hostname:string;port:string;user:string;identityfile:string[];identityagent:string;certificatefile:string[];identitiesonly:string;proxyjump:string;proxycommand:string};
const effectiveCache=new Map<string,Promise<Effective>>();
export function clearEffectiveCache(target:string){effectiveCache.delete(target);}
export async function effective(target:string):Promise<Effective>{let pending=effectiveCache.get(target);if(!pending){if(effectiveCache.size>=64)effectiveCache.delete(effectiveCache.keys().next().value!);pending=loadEffective(target);effectiveCache.set(target,pending);pending.catch(()=>effectiveCache.delete(target));}return pending;}
async function loadEffective(target:string):Promise<Effective>{const r=await run('ssh',['-G',target],{timeout:10000});if(r.code)throw new WdxError('WDX_SSH_CONFIG',r.stderr);const m:Record<string,string[]>={};for(const line of r.stdout.split('\n')){const i=line.indexOf(' ');if(i<0)continue;const k=line.slice(0,i),v=line.slice(i+1).trim();(m[k]??=[]).push(v);}return {hostname:m.hostname?.[0]??target,port:m.port?.[0]??'22',user:m.user?.[0]??os.userInfo().username,identityfile:m.identityfile??[],identityagent:m.identityagent?.[0]??'none',certificatefile:m.certificatefile??[],identitiesonly:m.identitiesonly?.[0]??'no',proxyjump:m.proxyjump?.[0]??'none',proxycommand:m.proxycommand?.[0]??'none'};}
export function connectionId(e:Effective){return createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0,24);}
export function controlPath(e:Effective){const dir=path.join(process.env.WERODEX_STATE_DIR??path.join(os.homedir(),'.local','state','werodex'),'sockets');privateDirectory(path.dirname(dir));privateDirectory(dir);return path.join(dir,connectionId(e)+'.sock');}
export async function ensureMaster(target:string){const e=await effective(target),sock=controlPath(e);let c=await run('ssh',['-S',sock,'-O','check',target],{timeout:5000});if(c.code===0)return {e,sock};if(fs.existsSync(sock))throw new WdxError('WDX_SSH_MASTER','SSH control socket exists but refuses requests');const r=await run('ssh',['-o','BatchMode=yes','-o','NumberOfPasswordPrompts=0','-o','ConnectionAttempts=1','-o','ConnectTimeout=15','-o','ControlMaster=yes','-o','ControlPersist=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-S',sock,'-Nf',target],{timeout:25000});if(r.code)throw new WdxError(/permission denied/i.test(r.stderr)?'WDX_AUTH':'WDX_REMOTE_UNAVAILABLE',r.stderr.trim()||'SSH connection failed');return {e,sock};}
export async function closeMaster(target:string,existingSock?:string){const sock=existingSock??controlPath(await effective(target));return run('ssh',['-S',sock,'-O','exit',target],{timeout:10000});}
export function masterClientArgs(sock:string){return ['-o','BatchMode=yes','-o','ControlMaster=no','-o','ProxyCommand=false','-o','ControlPath='+sock];}
export async function remote(config:Config,script:string,args:string[]=[],timeout=60000,maxBytes=8*1024*1024,options:{lane?:'control'|'blocking';existingOnly?:boolean;requestId?:string}={}):Promise<Result>{
 const d=await import('./daemon');if(!options.existingOnly)await d.ensureDaemon();
 return d.rpc({op:'exec',target:config.remote.target,config,request:{script,args,timeout,maxBytes,requestId:options.requestId??randomUUID(),lane:options.lane??(timeout>120000?'blocking':'control'),existingOnly:options.existingOnly}},timeout+190000);
}
export async function remoteAction(config:Config,action:string,payload:any={},options:{existingOnly?:boolean;lane?:'control'|'blocking';timeout?:number;maxBytes?:number;onData?:(kind:'O'|'E',data:Buffer)=>Promise<void>}={}){
 const d=await import('./daemon');if(!options.existingOnly)await d.ensureDaemon();const timeout=options.timeout??60000;
 const result=await d.rpc({op:'action',target:config.remote.target,config,request:{script:'',args:[],requestId:randomUUID(),timeout,maxBytes:options.maxBytes??8*1024*1024,lane:options.lane??'control',existingOnly:options.existingOnly,action,payload,root:config.remote.project,policy:PathPolicyEngine.policyData(config)}},timeout+190000,options.onData);
 if(result.error){const match=/^(WDX_[A-Z_]+):?/.exec(result.error);throw new WdxError(match?.[1]??'WDX_REMOTE',result.error);}
 return result;
}
export function rsyncSsh(sock:string){return 'ssh '+masterClientArgs(sock).map(shQuote).join(' ');}
export async function gitState(config:Config,localRoot?:string){
 if(localRoot)await localGitRoot(localRoot);
 const snapshot=(await remoteAction(config,'git.state')).value;const remoteHead=snapshot.head,remoteDirty=snapshot.dirty;
 const local=localRoot?await run('git',['rev-parse','HEAD'],{cwd:localRoot}):undefined;
 const localDirty=localRoot?await run('git',['status','--porcelain','--untracked-files=all'],{cwd:localRoot}):undefined;
 const lh=local?.code===0?local.stdout.trim():null,rh=remoteHead||null;let ancestry:'same'|'local-ancestor'|'remote-ancestor'|'diverged'|'unknown'='unknown';
 if(lh&&rh){if(lh===rh)ancestry='same';else if(localRoot){const a=await run('git',['merge-base','--is-ancestor',lh,rh],{cwd:localRoot});const b=await run('git',['merge-base','--is-ancestor',rh,lh],{cwd:localRoot});if(a.code===0)ancestry='local-ancestor';else if(b.code===0)ancestry='remote-ancestor';else if((await run('git',['cat-file','-e',rh+'^{commit}'],{cwd:localRoot})).code===0)ancestry='diverged';}}
 return {localHead:lh,remoteHead:rh,ancestry,localDirty:!!localDirty?.stdout.trim(),remoteDirty:!!remoteDirty};
}

export async function startPasswordMaster(target:string,password:string){const d=await import('./daemon');await d.ensureDaemon();return d.rpc({op:'unlock',target,password},60000);}
export async function createPasswordMaster(target:string,password:string){const e=await effective(target),sock=controlPath(e);if(fs.existsSync(sock))throw new WdxError('WDX_SSH_MASTER','Existing master socket must be resolved before password login');const ask=path.join(path.dirname(sock),'ask-'+process.pid+'-'+Date.now()+'.sock');const server=net.createServer(s=>{s.end(password+'\n');});await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(ask,()=>{fs.chmodSync(ask,0o600);resolve();});});try{const env={...process.env,SSH_ASKPASS:path.join(__dirname,'askpass.js'),SSH_ASKPASS_REQUIRE:'force',DISPLAY:'werodex',WERODEX_ASKPASS_SOCKET:ask};const r=await run('ssh',['-o','BatchMode=no','-o','PreferredAuthentications=password','-o','NumberOfPasswordPrompts=1','-o','ControlMaster=yes','-o','ControlPersist=yes','-S',sock,'-Nf',target],{env,timeout:30000});if(r.code)throw new WdxError('WDX_AUTH',r.stderr||'Password login failed');}finally{server.close();try{fs.unlinkSync(ask);}catch{}}}
