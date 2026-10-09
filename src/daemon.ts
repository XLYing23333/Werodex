import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {WdxError,Config,privateDirectory,defaultConfig} from './core';
import {Connection,RemoteRequest} from './transport';
import {effective,connectionId,clearEffectiveCache} from './ssh';
export const socketDir=()=>process.env.WERODEX_STATE_DIR??path.join(os.homedir(),'.local','state','werodex');
export const socketPath=()=>path.join(socketDir(),'daemon.sock');
const VERSION=2,MAX_MESSAGE=768*1024*1024,MAX_REQUEST=32*1024*1024;
const peerScript='import socket,struct; s=socket.socket(fileno=3); print(*struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)))';
function peer(s:net.Socket){const fd=(s as any)._handle?.fd;if(!Number.isInteger(fd))throw new WdxError('WDX_IPC','Peer credentials unavailable');const p=spawnSync('python3',['-c',peerScript],{stdio:['ignore','pipe','pipe',fd],timeout:3000});if(p.status!==0)throw new WdxError('WDX_IPC','SO_PEERCRED validation failed');const [pid,uid]=p.stdout.toString().trim().split(' ').map(Number);return {pid,uid};}
const connections=new Map<string,Connection>();
function config(q:any):Config{const c=q.config??defaultConfig(q.target,'/tmp/werodex-placeholder');if(c.remote?.target!==q.target||!Number.isInteger(c.runtime?.maxChannels)||c.runtime.maxChannels<1||c.runtime.maxChannels>16)throw new WdxError('WDX_IPC','Invalid connection configuration');return c;}
async function connection(target:string){if(typeof target!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(target))throw new WdxError('WDX_IPC','Invalid SSH target');const id=connectionId(await effective(target));let c=connections.get(id);if(!c){c=new Connection(target,socketDir(),id);connections.set(id,c);}return c;}
function encode(value:unknown){const json=Buffer.from(JSON.stringify(value));const chunks:Buffer[]=[];for(let i=0;i<json.length;i+=65536){const part=json.subarray(i,i+65536),length=Buffer.alloc(4);length.writeUInt32BE(part.length);chunks.push(length,part);}chunks.push(Buffer.alloc(4));return chunks;}
function reader(max:number,done:(data:Buffer)=>void,fail:(e:Error)=>void){let pending=Buffer.alloc(0),total=0,ended=false;const chunks:Buffer[]=[];return (data:Buffer)=>{if(ended)return;pending=Buffer.concat([pending,data]);try{while(pending.length>=4){const n=pending.readUInt32BE(0);if(n>65536)throw new WdxError('WDX_IPC','Invalid IPC frame size');if(n===0){ended=true;done(Buffer.concat(chunks));return;}if(pending.length<n+4)return;const body=pending.subarray(4,n+4);total+=body.length;if(total>max)throw new WdxError('WDX_IPC','IPC message exceeds limit');chunks.push(body);pending=pending.subarray(n+4);}}catch(e){ended=true;fail(e as Error);}};}
async function handle(q:any,ownerPid?:number):Promise<unknown>{
 if(q.op==='ping')return {version:VERSION,pid:process.pid};
 const c=config(q),pool=await connection(q.target);
 if(q.op==='status')return pool.snapshot();
 if(q.op==='disconnect'){await pool.disconnect();for(const [id,item] of connections)if(item===pool)connections.delete(id);return true;}
 if(q.op==='reconnect'){await pool.disconnect();for(const [id,item] of connections)if(item===pool)connections.delete(id);clearEffectiveCache(q.target);const refreshed=await connection(q.target);await refreshed.reconnect(c.runtime.maxChannels);return refreshed.snapshot();}
 if(q.op==='unlock'){if(typeof q.password!=='string'||q.password.length>65536)throw new WdxError('WDX_IPC','Invalid credential');await pool.connect(c.runtime.maxChannels,q.password);return pool.snapshot();}
 if(q.op==='release'){pool.release(String(q.leaseId));return true;}
 if(q.op==='lease'){if(Number(q.pid)!==ownerPid)throw new WdxError('WDX_IPC','Lease owner must match the IPC peer');return pool.acquire(c,String(q.leaseId),Number(q.pid));}
 if(q.op==='connect'){await pool.connect(c.runtime.maxChannels);return pool.snapshot();}
 if(q.op==='request-status')return pool.requestStatus(c,String(q.requestId));
 if(q.op==='exec'){
  const r=q.request as RemoteRequest;
  if(!r||typeof r.script!=='string'||Buffer.byteLength(r.script)>16*1024*1024||!Array.isArray(r.args)||r.args.some(x=>typeof x!=='string'||x.includes('\0'))||!/^[a-f0-9-]{36}$/.test(r.requestId)||!Number.isSafeInteger(r.timeout)||r.timeout<1||r.timeout>7*86400000||!Number.isSafeInteger(r.maxBytes)||r.maxBytes<1||r.maxBytes>256*1024*1024||!['control','blocking'].includes(r.lane))throw new WdxError('WDX_IPC','Invalid execution request');
  return pool.execute(c,r);
 }
 throw new WdxError('WDX_IPC','Unknown daemon operation');
}
export async function serve(){
 privateDirectory(socketDir());const sp=socketPath();let existing:fs.Stats|undefined;
 try{existing=fs.lstatSync(sp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(existing){if(!existing.isSocket()||existing.uid!==(process.getuid?.()??-1))throw new WdxError('WDX_DAEMON','Unsafe existing daemon socket');try{await rpc({op:'ping'},1000);throw new WdxError('WDX_DAEMON','Daemon already running');}catch(e){if(e instanceof WdxError&&e.code==='WDX_DAEMON'&&e.message==='Daemon already running')throw e;fs.unlinkSync(sp);}}
 const server=net.createServer(s=>{
  let ownerPid:number;try{const owner=peer(s);ownerPid=owner.pid;if(owner.uid!==(process.getuid?.()??-1)){s.destroy();return;}}catch{s.destroy();return;}
  let first=true,legacy=false,legacyData='',handled=false;
  const dispatch=(data:Buffer)=>{if(handled)return;handled=true;let q:any;try{q=JSON.parse(data.toString());}catch{s.destroy();return;}Promise.resolve(handle(q,ownerPid)).then(ok=>({ok})).catch(e=>({error:e.code??'WDX_DAEMON',message:e.message})).then(response=>{if(s.destroyed)return;if(legacy)s.end(JSON.stringify(response)+'\n');else{for(const frame of encode(response))s.write(frame);s.end();}});};
  const consume=reader(MAX_REQUEST,dispatch,()=>s.destroy());
  s.on('data',(data:Buffer)=>{if(first){legacy=data[0]===123;first=false;}if(legacy){legacyData+=data.toString();if(Buffer.byteLength(legacyData)>MAX_REQUEST){s.destroy();return;}const newline=legacyData.indexOf('\n');if(newline>=0)dispatch(Buffer.from(legacyData.slice(0,newline)));}else consume(data);});s.on('error',()=>{});
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(sp,()=>{fs.chmodSync(sp,0o600);resolve();});});
 let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;await Promise.allSettled([...connections.values()].map(c=>c.disconnect()));server.close(()=>{try{fs.unlinkSync(sp);}catch{}process.exit(0);});setTimeout(()=>process.exit(0),2000).unref();};
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
export function rpc(q:unknown,timeout=30000):Promise<any>{return new Promise((resolve,reject)=>{
 try{privateDirectory(socketDir(),false);}catch(e){reject(e);return;}
 const s=net.createConnection(socketPath());let settled=false;const finish=(e?:Error,v?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);s.destroy();if(e)reject(e);else resolve(v);};
 const timer=setTimeout(()=>finish(new WdxError('WDX_DAEMON','Daemon request timed out')),timeout);
 const consume=reader(MAX_MESSAGE,data=>{try{const r=JSON.parse(data.toString());if(r.error)finish(new WdxError(r.error,r.message??r.error));else finish(undefined,r.ok);}catch(e){finish(e as Error);}},e=>finish(e));
 s.on('connect',()=>{for(const chunk of encode(q))s.write(chunk);});s.on('data',consume);s.on('error',e=>finish(e));s.on('end',()=>{if(!settled)finish(new WdxError('WDX_DAEMON','Daemon connection ended without a result'));});
});}
async function probe(){return new Promise<{version:number;pid:number}>((resolve,reject)=>{
 const s=net.createConnection(socketPath());let data='';const timer=setTimeout(()=>{s.destroy();reject(Error('Probe timeout'));},1000);s.on('connect',()=>s.write('{"op":"ping"}\n'));s.on('data',b=>{data+=b.toString();if(!data.includes('\n'))return;clearTimeout(timer);try{const response=JSON.parse(data.split('\n')[0]),owner=peer(s);if(owner.uid!==process.getuid?.())throw Error('Invalid daemon owner');s.destroy();resolve({version:response.ok?.version??1,pid:owner.pid});}catch(e){s.destroy();reject(e);}});s.on('error',e=>{clearTimeout(timer);reject(e);});
});}
let starting:Promise<void>|undefined;
export async function ensureDaemon(){if(starting)return starting;starting=(async()=>{
 privateDirectory(socketDir());
 try{const old=await probe();if(old.version===VERSION)return;const command=fs.readFileSync(`/proc/${old.pid}/cmdline`,'utf8').split('\0');if(!command.includes(path.join(__dirname,'daemon-cli.js')))throw new WdxError('WDX_DAEMON','Existing daemon cannot be safely upgraded');process.kill(old.pid,'SIGTERM');for(let i=0;i<30&&fs.existsSync(socketPath());i++)await new Promise(r=>setTimeout(r,100));}catch(e){if(e instanceof WdxError)throw e;}
 const lock=path.join(socketDir(),'daemon-start.lock');let owner=false;
 for(let attempt=0;attempt<2;attempt++)try{const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);owner=true;break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;try{const pid=Number(fs.readFileSync(lock,'utf8'));if(!Number.isSafeInteger(pid)||pid<=0)throw Error();process.kill(pid,0);break;}catch{fs.rmSync(lock,{force:true});}}

 try{if(owner){const child=spawn(process.execPath,[path.join(__dirname,'daemon-cli.js')],{detached:true,stdio:'ignore'});child.unref();}
  for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,100));try{if((await probe()).version===VERSION)return;}catch{}}
  throw new WdxError('WDX_DAEMON','Could not start daemon');
 }finally{if(owner)fs.rmSync(lock,{force:true});}
 })().finally(()=>{starting=undefined;});return starting;}
// Logical operations do not reserve physical channels. Only a transfer or an
// explicit interactive client needs a lease; exec requests use the fixed pool.
export async function withLease<T>(_config:Config,fn:()=>Promise<T>):Promise<T>{return fn();}
export async function withTransferLease<T>(config:Config,fn:(sock:string)=>Promise<T>):Promise<T>{await ensureDaemon();const leaseId=randomUUID();const lease=await rpc({op:'lease',target:config.remote.target,config,pid:process.pid,leaseId},190000);try{return await fn(lease.sock);}finally{await rpc({op:'release',target:config.remote.target,config,leaseId}).catch(()=>{});}}
export async function existingConnection(config:Config){try{return await rpc({op:'status',target:config.remote.target,config},1500);}catch{return null;}}
