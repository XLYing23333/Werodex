import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {WdxError,Config,privateDirectory,defaultConfig} from './core';
import {Connection,RemoteRequest} from './transport';
import {effective,connectionId,clearEffectiveCache} from './ssh';
import {truncateUtf8} from './output';
import {StringDecoder} from 'node:string_decoder';
import {Frames,writeMessage,writePacket} from './frames';
export const socketDir=()=>process.env.WERODEX_STATE_DIR??path.join(os.homedir(),'.local','state','werodex');
export const socketPath=()=>path.join(socketDir(),'daemon.sock');
const VERSION=3,MAX_INPUT=20*1024*1024,MAX_QUEUED=128,MAX_INFLIGHT=64*1024*1024;
const peerScript='import socket,struct; s=socket.socket(fileno=3); print(*struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)))';
async function peer(socket:net.Socket):Promise<{pid:number;uid:number}>{
 const fd=(socket as any)._handle?.fd;if(!Number.isInteger(fd))throw new WdxError('WDX_IPC','Peer credentials unavailable');
 return new Promise((resolve,reject)=>{const child=spawn('python3',['-c',peerScript],{stdio:['ignore','pipe','pipe',fd]});let output='';const timer=setTimeout(()=>{child.kill();reject(new WdxError('WDX_IPC','Credential check timed out'));},3000);child.stdout!.on('data',data=>{output+=data.toString();});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code)reject(new WdxError('WDX_IPC','Credential check failed'));else{const [pid,uid]=output.trim().split(' ').map(Number);resolve({pid,uid});}});});
}
const connections=new Map<string,Connection>();let admitted=0,inputBytes=0,peakInputBytes=0;
function config(q:any):Config{const c=q.config??defaultConfig(q.target,'/tmp/werodex-placeholder');if(c.remote?.target!==q.target||!Number.isInteger(c.runtime?.maxChannels)||c.runtime.maxChannels<1||c.runtime.maxChannels>16)throw new WdxError('WDX_IPC','Invalid connection configuration');return c;}
async function connection(target:string){
 if(typeof target!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(target))throw new WdxError('WDX_IPC','Invalid SSH target');const id=connectionId(await effective(target));let pool=connections.get(id);
 if(!pool){if(connections.size>=8)throw new WdxError('WDX_CONNECTION_LIMIT','At most eight connection identities per daemon');pool=new Connection(target,socketDir(),id);connections.set(id,pool);}return pool;
}
async function handle(q:any,ownerPid:number,emit:(kind:'O'|'E',data:Buffer)=>Promise<void>):Promise<any>{
 if(q.op==='ping')return {version:VERSION,pid:process.pid};
 if(q.op==='diagnostics')return {version:VERSION,pid:process.pid,queued:admitted,inputBytes,peakInputBytes,memory:process.memoryUsage(),connections:[...connections.values()].map(pool=>pool.snapshot())};
 const c=config(q),pool=await connection(q.target);
 if(q.op==='status')return pool.snapshot();
 if(q.op==='disconnect'){await pool.disconnect();for(const [id,item] of connections)if(item===pool)connections.delete(id);return true;}
 if(q.op==='reconnect'){await pool.disconnect();for(const [id,item] of connections)if(item===pool)connections.delete(id);clearEffectiveCache(q.target);const refreshed=await connection(q.target);await refreshed.reconnect(c.runtime.maxChannels);return refreshed.snapshot();}
 if(q.op==='unlock'){if(typeof q.password!=='string'||q.password.length>65536)throw new WdxError('WDX_IPC','Invalid credential');await pool.connect(c.runtime.maxChannels,q.password);return pool.snapshot();}
 if(q.op==='release'){pool.release(String(q.leaseId));return true;}
 if(q.op==='lease'){if(Number(q.pid)!==ownerPid)throw new WdxError('WDX_IPC','Lease owner must match IPC peer');return pool.acquire(c,String(q.leaseId),Number(q.pid));}
 if(q.op==='connect'){await pool.connect(c.runtime.maxChannels);return pool.snapshot();}
 if(q.op==='request-status')return pool.requestStatus(c,String(q.requestId),emit);
 if(q.op==='cancel'){pool.cancel(String(q.requestId));return true;}
 if(q.op==='exec'||q.op==='action'){
  const request=q.request as RemoteRequest;
  if(!request||typeof request.script!=='string'||Buffer.byteLength(request.script)>16*1024*1024||!Array.isArray(request.args)||request.args.some(arg=>typeof arg!=='string'||arg.includes('\0'))||!/^[a-f0-9-]{36}$/.test(request.requestId)||!Number.isSafeInteger(request.timeout)||request.timeout<1||request.timeout>7*86400000||!Number.isSafeInteger(request.maxBytes)||request.maxBytes<1||request.maxBytes>256*1024*1024||!['control','blocking'].includes(request.lane))throw new WdxError('WDX_IPC','Invalid execution request');
  const result=await pool.execute(c,{...request,onData:emit});const {stdout,stderr,...metadata}=result;return metadata;
 }
 throw new WdxError('WDX_IPC','Unknown daemon operation');
}
export async function serve(){
 privateDirectory(socketDir());const file=socketPath();
 if(fs.existsSync(file)){const st=fs.lstatSync(file);if(!st.isSocket()||st.uid!==process.getuid?.())throw new WdxError('WDX_DAEMON','Unsafe daemon socket');try{await rpc({op:'ping'},1000);throw new WdxError('WDX_DAEMON','Daemon already running');}catch(e){if(e instanceof WdxError&&e.message==='Daemon already running')throw e;fs.unlinkSync(file);}}
 const clients=new Set<net.Socket>();
 const server=net.createServer(async socket=>{
  if(clients.size>=32){socket.destroy();return;}clients.add(socket);socket.pause();socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));
  let owner:{pid:number;uid:number};try{owner=await peer(socket);if(owner.uid!==process.getuid?.())throw Error('Invalid UID');}catch{socket.destroy();return;}
  let ready=false,hello='',parts:Buffer[]=[],size=0,writeTail=Promise.resolve();const requests=new Map<string,string>();
  const send=(value:unknown)=>{writeTail=writeTail.then(()=>writeMessage(socket,value));writeTail.catch(()=>socket.destroy());return writeTail;};
  const emit=(id:string,kind:'O'|'E',data:Buffer)=>{writeTail=writeTail.then(()=>writePacket(socket,kind,Buffer.concat([Buffer.from(id),data])));writeTail.catch(()=>socket.destroy());return writeTail;};
  const dispatch=(data:Buffer,reserved:number)=>{
   let envelope:any;try{envelope=JSON.parse(data.toString());}catch{inputBytes-=reserved;socket.destroy();return;}
   const id=envelope.id;if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)){inputBytes-=reserved;socket.destroy();return;}
   if(admitted>=MAX_QUEUED){inputBytes-=reserved;void send({id,error:'WDX_QUEUE_LIMIT',message:'Global request queue is full'});return;}
   admitted++;if(envelope.q?.request?.requestId)requests.set(id,envelope.q.request.requestId);
   Promise.resolve(handle(envelope.q,owner.pid,(kind,chunk)=>emit(id,kind,chunk))).then(ok=>send({id,ok})).catch(error=>send({id,error:error.code??'WDX_DAEMON',message:error.message})).finally(()=>{admitted--;inputBytes-=reserved;requests.delete(id);}).catch(()=>{});
  };
  const frames=new Frames((kind,data)=>{if(kind==='M'){size+=data.length;inputBytes+=data.length;peakInputBytes=Math.max(peakInputBytes,inputBytes);if(size>MAX_INPUT||inputBytes>MAX_INFLIGHT)throw new WdxError('WDX_QUEUE_LIMIT','Global input byte budget exceeded');parts.push(data);}else if(kind==='J'){const message=Buffer.concat(parts);const reserved=size;size=0;parts=[];dispatch(message,reserved);}else throw new WdxError('WDX_PROTOCOL','Unexpected IPC frame');});
  socket.on('data',(data:Buffer)=>{try{if(!ready){hello+=data.toString();if(hello.length>4096)throw Error('Invalid handshake');if(!hello.includes('\n'))return;const request=JSON.parse(hello.split('\n')[0]);if(request.op!=='ping')throw Error('Handshake required');ready=true;socket.write(JSON.stringify({ok:{version:VERSION,pid:process.pid}})+'\n');return;}frames.push(data);}catch{inputBytes-=size;size=0;parts=[];socket.destroy();}});
  socket.on('close',()=>{inputBytes-=size;size=0;parts=[];});socket.resume();
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(file,()=>{fs.chmodSync(file,0o600);resolve();});});
 const maintenance=setInterval(()=>{
  try{const directory=path.join(socketDir(),'requests');if(!fs.existsSync(directory))return;let total=0;const terminal: {file:string;mtime:number;size:number}[]=[];
   for(const name of fs.readdirSync(directory)){const file=path.join(directory,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>65536)continue;const record=JSON.parse(fs.readFileSync(file,'utf8'));total+=stat.size;if(!['running','unknown'].includes(record.state))terminal.push({file,mtime:stat.mtimeMs,size:stat.size});}
   for(const item of terminal.sort((a,b)=>a.mtime-b.mtime))if(Date.now()-item.mtime>3600000||total>16*1024*1024){fs.unlinkSync(item.file);total-=item.size;}
  }catch{}
 },60000);maintenance.unref();
 let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;clearInterval(maintenance);await Promise.allSettled([...connections.values()].map(pool=>pool.disconnect()));for(const client of clients)client.destroy();server.close(()=>{try{fs.unlinkSync(file);}catch{}process.exit(0);});setTimeout(()=>process.exit(0),2000).unref();};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
class Session {
 socket:net.Socket;readonly ready:Promise<void>;dead=false;private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;out:Buffer[];err:Buffer[];bytes:number;tail:Promise<void>;onData?:(kind:'O'|'E',chunk:Buffer)=>Promise<void>}>();private writeTail=Promise.resolve();private outputQueued=0;
 private consumerBudget(){return [...this.pending.values()].some(item=>!item.onData)?1048576:262144;}
 constructor(){
  this.socket=net.createConnection(socketPath());const socket=this.socket;let handshake='',authenticated=false,parts:Buffer[]=[],bytes=0;
  this.ready=new Promise<void>((resolve,reject)=>{
   const startup=setTimeout(()=>{socket.destroy();reject(new WdxError('WDX_DAEMON','Daemon handshake timed out'));},1500);
   socket.on('connect',async()=>{try{const owner=await peer(socket);if(owner.uid!==process.getuid?.())throw Error('Daemon UID mismatch');(this as any).owner=owner;socket.write('{"op":"ping"}\n');}catch(e){reject(e);socket.destroy();}});
   const frames=new Frames((kind,data)=>{
    if(kind==='M'){bytes+=data.length;if(bytes>8*1024*1024)throw new WdxError('WDX_OUTPUT_LIMIT','Metadata response exceeds 8 MiB');parts.push(data);return;}
    if(kind==='J'){const value=JSON.parse(Buffer.concat(parts).toString());parts=[];bytes=0;const item=this.pending.get(value.id);if(!item)return;this.pending.delete(value.id);clearTimeout(item.timer);
     item.tail.then(()=>{if(value.error)item.reject(new WdxError(value.error,value.message));else{const result=value.ok;if(item.out.length||item.err.length||['exec','action','request-status'].includes((item as any).op))item.resolve({...result,stdout:truncateUtf8(new StringDecoder('utf8').write(Buffer.concat(item.out)),(item as any).maxBytes),stderr:truncateUtf8(new StringDecoder('utf8').write(Buffer.concat(item.err)),(item as any).maxBytes)||result?.error||''});else item.resolve(result);}}).catch(item.reject);if(!this.pending.size)socket.unref();return;}
    if(!['O','E'].includes(kind)||data.length<36)throw Error('Invalid output frame');const id=data.subarray(0,36).toString(),item=this.pending.get(id);if(!item)return;const chunk=data.subarray(36);
    if(item.onData){this.outputQueued+=chunk.length;if(this.outputQueued>=this.consumerBudget())socket.pause();item.tail=item.tail.then(()=>item.onData!(kind as 'O'|'E',chunk)).finally(()=>{this.outputQueued-=chunk.length;if(this.outputQueued<this.consumerBudget())socket.resume();});item.tail.catch(item.reject);}else{item.bytes+=chunk.length;if(item.bytes>16*1024*1024)throw new WdxError('WDX_OUTPUT_LIMIT','Use raw streaming or a resource reference');(kind==='O'?item.out:item.err).push(chunk);}
   });
   socket.on('data',(data:Buffer)=>{try{if(!authenticated){handshake+=data.toString();if(handshake.length>4096)throw Error('Invalid daemon handshake');if(!handshake.includes('\n'))return;clearTimeout(startup);const hello=JSON.parse(handshake.split('\n')[0]);if(hello.ok?.version!==VERSION){reject(new WdxError('WDX_DAEMON_OLD',String((this as any).owner.pid)));socket.destroy();return;}authenticated=true;resolve();socket.unref();return;}frames.push(data);}catch(e){this.fail(e as Error);socket.destroy();}});
   socket.on('error',e=>{clearTimeout(startup);reject(e);this.fail(e);});socket.on('close',()=>{clearTimeout(startup);const error=new WdxError('WDX_DAEMON','Daemon connection closed');reject(error);this.fail(error);});
  });this.ready.catch(()=>{});
 }
 private fail(error:Error){this.dead=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();}
 async call(q:any,timeout:number,onData?:(kind:'O'|'E',chunk:Buffer)=>Promise<void>){await this.ready;if(this.dead)throw new WdxError('WDX_DAEMON','Session closed');const id=randomUUID();this.socket.ref();return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new WdxError('WDX_DAEMON','Request deadline exceeded'));if(q.request?.requestId)void this.call({op:'cancel',target:q.target,config:q.config,requestId:q.request.requestId},3000).catch(()=>{});if(!this.pending.size)this.socket.unref();},timeout);const item={resolve,reject,timer,out:[],err:[],bytes:0,tail:Promise.resolve(),onData,op:q.op,maxBytes:q.request?.maxBytes??8*1024*1024};this.pending.set(id,item);if(this.outputQueued<this.consumerBudget())this.socket.resume();this.writeTail=this.writeTail.then(()=>writeMessage(this.socket,{id,q}));this.writeTail.catch(error=>{clearTimeout(timer);this.pending.delete(id);reject(error);});});}
 close(){this.socket.destroy();}
}
let session:Session|undefined,sessionRoot='',starting:Promise<void>|undefined;
function resetSession(){const old=session;session=undefined;old?.close();}
async function openSession(){if(sessionRoot!==socketDir()){resetSession();sessionRoot=socketDir();}if(!session||session.dead)session=new Session();await session.ready;return session;}
export async function rpc(q:unknown,timeout=30000,onData?:(kind:'O'|'E',data:Buffer)=>Promise<void>){privateDirectory(socketDir(),false);return (await openSession()).call(q,timeout,onData);}
export async function ensureDaemon(){
 if(session&&!session.dead&&sessionRoot===socketDir()){await session.ready;return;}if(starting)return starting;
 starting=(async()=>{
  privateDirectory(socketDir());try{await openSession();return;}catch(error){resetSession();if(error instanceof WdxError&&error.code==='WDX_DAEMON_OLD'){const pid=Number(error.message),command=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');if(!command.includes(path.join(__dirname,'daemon-cli.js')))throw new WdxError('WDX_DAEMON','Cannot safely upgrade daemon');process.kill(pid,'SIGTERM');for(let i=0;i<30&&fs.existsSync(socketPath());i++)await new Promise(resolve=>setTimeout(resolve,50));}}
  const lock=path.join(socketDir(),'daemon-start.lock');let owner=false;
  for(let i=0;i<2;i++)try{const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);owner=true;break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;try{const pid=Number(fs.readFileSync(lock,'utf8'));if(!Number.isSafeInteger(pid)||pid<1)throw Error();process.kill(pid,0);break;}catch{fs.rmSync(lock,{force:true});}}
  try{if(owner){const child=spawn(process.execPath,[path.join(__dirname,'daemon-cli.js')],{detached:true,stdio:'ignore'});child.unref();}for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,50));try{await openSession();return;}catch{resetSession();}}throw new WdxError('WDX_DAEMON','Could not start daemon');}finally{if(owner)fs.rmSync(lock,{force:true});}
 })().finally(()=>{starting=undefined;});return starting;
}
export async function withLease<T>(_config:Config,fn:()=>Promise<T>):Promise<T>{return fn();}
export async function withTransferLease<T>(config:Config,fn:(sock:string)=>Promise<T>):Promise<T>{await ensureDaemon();const leaseId=randomUUID();const lease=await rpc({op:'lease',target:config.remote.target,config,pid:process.pid,leaseId},190000);try{return await fn(lease.sock);}finally{await rpc({op:'release',target:config.remote.target,config,leaseId}).catch(()=>{});}}
export async function existingConnection(config:Config){try{return await rpc({op:'status',target:config.remote.target,config},1500);}catch{return null;}}
export async function closeSession(){resetSession();}
