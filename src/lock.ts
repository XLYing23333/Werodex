import * as fs from 'node:fs';
import * as path from 'node:path';
import {spawn} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {privateDirectory,WdxError} from './core';
const context=new AsyncLocalStorage<Map<string,{active:boolean}>>();
function start(pid:number){const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];}
export async function withWorkspaceLock<T>(root:string,fn:()=>Promise<T>,timeout=180000):Promise<T>{
 const real=fs.realpathSync(root);if(context.getStore()?.get(real)?.active)return fn();
 const directory=privateDirectory(path.join(real,'.werodex')),file=path.join(directory,'mutation.lock');
 // flock locks the inherited open-file description. This process retains its fd through
 // the whole transaction, so helper exit cannot release the lock; process death does.
 const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600),token={active:true};
 try{
  if(!fs.fstatSync(fd).isFile())throw new WdxError('WDX_PATH','Mutation lock must be a regular file');
  await new Promise<void>((resolve,reject)=>{const child=spawn('flock',['-x','-w',String(timeout/1000),'3'],{stdio:['ignore','ignore','pipe',fd]});const timer=setTimeout(()=>{child.kill();reject(new WdxError('WDX_WORKSPACE_BUSY','Workspace mutation lock timed out'));},timeout+1000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new WdxError('WDX_WORKSPACE_BUSY','Workspace mutation lock is busy or flock unavailable'));});});
  fs.ftruncateSync(fd,0);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,start:start(process.pid)}));
  const active=new Map(context.getStore()??[]);active.set(real,token);return await context.run(active,fn);
 }finally{token.active=false;fs.closeSync(fd);}
}
