import * as fs from 'node:fs';
import * as path from 'node:path';
import {spawn,ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {Config,Result,WdxError,privateDirectory,atomicJson,shQuote} from './core';
import {effective,connectionId,controlPath,ensureMaster,closeMaster,masterClientArgs} from './ssh';
import {controlBootstrap} from './worker';
export type RemoteRequest={script:string;args:string[];timeout:number;maxBytes:number;requestId:string;lane:'control'|'blocking';existingOnly?:boolean};
export type RequestResult=Result&{requestId:string;state:string};
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export const channelLimit=(n:number)=>Math.max(1,Math.min(3,Math.floor(n)||3));
class Channel {
 child:ChildProcessWithoutNullStreams;busy=false;dead=false;closed=false;readonly exited:Promise<void>;
 private pending?:{id:string;max:number;out:Buffer[];err:Buffer[];outSize:number;errSize:number;code:number;state:string;resolve:(v:RequestResult)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout};
 private ready:Promise<void>;
 constructor(target:string,sock:string,id:string,slot:number){
  this.child=spawn('ssh',[...masterClientArgs(sock),'-T',target,'bash -c '+shQuote(controlBootstrap(id,slot))],{stdio:['pipe','pipe','pipe']});
  this.exited=new Promise(resolve=>{this.child.once('exit',()=>{this.closed=true;resolve();});this.child.once('error',()=>{this.closed=true;resolve();});});
  const registry=clientRegistry(sock,id,slot);atomicJson(registry,{pid:this.child.pid,start:processStart(this.child.pid!),sock});
  this.child.once('exit',()=>{try{if(JSON.parse(fs.readFileSync(registry,'utf8')).pid===this.child.pid)fs.unlinkSync(registry);}catch{}});
  let stderr='';this.child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8192);});
  this.ready=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{reject(new WdxError('WDX_SSH_MASTER','Control worker startup timed out'));this.close();},25000);
   this.child.once('error',e=>{clearTimeout(timer);reject(e);this.fail(e);});
   this.child.once('exit',()=>{clearTimeout(timer);const e=new WdxError('WDX_REMOTE_UNAVAILABLE',stderr||'Persistent SSH channel closed');reject(e);this.fail(e);});
   const lines=createInterface({input:this.child.stdout});lines.on('line',line=>{
    if(line==='READY'){clearTimeout(timer);resolve();return;}
    try{this.frame(line);}catch(e){this.fail(e as Error);this.close();}
   });
  });this.ready.catch(()=>{});
 }
 private fail(e:Error){this.dead=true;const p=this.pending;if(p){clearTimeout(p.timer);this.pending=undefined;p.reject(new WdxError('WDX_REQUEST_UNKNOWN',`Request ${p.id} result is unknown: ${e.message}. Do not replay writes; use request status ${p.id} after reconnect.`));}}
 private frame(line:string){
  const [kind,id,...parts]=line.split(' '),p=this.pending;if(!p||p.id!==id)throw new WdxError('WDX_PROTOCOL','Unexpected control response');
  if(kind==='B'){p.code=Number(parts[0]);p.state=parts[1];if(!Number.isInteger(p.code))throw new WdxError('WDX_PROTOCOL','Invalid exit code');}
  else if(kind==='O'||kind==='E'){
   const bytes=Buffer.from(parts[0]??'','base64');if(kind==='O'){p.outSize+=bytes.length;p.out.push(bytes);}else{p.errSize+=bytes.length;p.err.push(bytes);}
   if(p.outSize>p.max||p.errSize>p.max)throw new WdxError('WDX_PROTOCOL','Control response exceeded request limit');
  }else if(kind==='D'||kind==='U'){
   clearTimeout(p.timer);this.pending=undefined;
   p.resolve({requestId:id,state:kind==='U'?parts[0]:p.state,code:kind==='U'?1:p.code,stdout:Buffer.concat(p.out).toString(),stderr:Buffer.concat(p.err).toString()});
  }else throw new WdxError('WDX_PROTOCOL','Invalid control frame');
 }
 async execute(request:RemoteRequest,query=false){
  await this.ready;if(this.dead)throw new WdxError('WDX_REMOTE_UNAVAILABLE','Control channel closed');
  if(this.pending)throw new WdxError('WDX_PROTOCOL','Control channel is busy');
  return new Promise<RequestResult>((resolve,reject)=>{
   const timer=setTimeout(()=>{this.fail(new Error('Control response deadline exceeded'));this.close();},request.timeout+5000);
   this.pending={id:request.requestId,max:request.maxBytes,out:[],err:[],outSize:0,errSize:0,code:1,state:'unknown',resolve,reject,timer};
   const script=Buffer.from(request.script||':\n').toString('base64');
   // The worker script location is private and based only on the UUID.
   const command='bash --noprofile --norc "$WDX_REQUEST_DIRECTORY/script.sh" '+request.args.map(shQuote).join(' ');
   this.child.stdin.write(query?'QUERY '+request.requestId+' '+(request.args[0]??'0')+'\n':`RUN ${request.requestId} ${request.timeout} ${request.maxBytes} ${script} ${Buffer.from(command).toString('base64')}\n`);
  });
 }
 close(){this.dead=true;this.child.stdin.end();this.child.kill('SIGTERM');this.fail(new Error('Control channel closed'));}
}
type ExternalLease={pid:number;start:string};
function processStart(pid:number){try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);return fields[0]==='Z'?null:(fields[19]??null);}catch{return null;}}
function clientRegistry(sock:string,id:string,slot:number){return path.join(privateDirectory(path.join(path.dirname(path.dirname(sock)),'control-clients')),id+'-'+slot+'.json');}
async function reclaimClient(sock:string,id:string,slot:number){
 const file=clientRegistry(sock,id,slot);let old:{pid:number;start:string;sock:string};try{old=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return;}
 if(old.sock===sock&&Number.isSafeInteger(old.pid)&&old.pid>0&&processStart(old.pid)===old.start){
  const command=fs.readFileSync(`/proc/${old.pid}/cmdline`,'utf8').split('\0');
  if(path.basename(command[0])!=='ssh'||!command.includes('ControlPath='+sock))throw new WdxError('WDX_SSH_MASTER','Cannot safely reclaim an old control client');
  process.kill(old.pid,'SIGTERM');for(let i=0;i<50&&processStart(old.pid)===old.start;i++)await pause(20);
  if(processStart(old.pid)===old.start){process.kill(old.pid,'SIGKILL');for(let i=0;i<50&&processStart(old.pid)===old.start;i++)await pause(20);}
  if(processStart(old.pid)===old.start)throw new WdxError('WDX_SSH_MASTER','Old control client did not exit');
 }
 fs.rmSync(file,{force:true});
}
export class Connection {
 readonly slots:Array<Channel|undefined>=[undefined,undefined];
 readonly leases=new Map<string,ExternalLease>();
 queued=0;reconnects=0;connectionAttempts=0;limit=3;state:'disconnected'|'connecting'|'ready'|'backoff'|'auth-paused'='disconnected';
 private connecting?:Promise<void>;private unavailableUntil=0;private failures=0;private sock='';private id='';private closing=false;
 constructor(readonly target:string,readonly stateRoot:string,id=''){
  this.id=id;
  if(id)try{const file=this.connectionStateFile();if(fs.lstatSync(file).isFile()){const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.version===1&&['auth-paused','backoff'].includes(saved.state)){this.state=saved.state;this.unavailableUntil=Number(saved.until)||0;this.failures=Number(saved.failures)||0;this.connectionAttempts=Number(saved.connectionAttempts)||0;this.reconnects=Number(saved.reconnects)||0;}}}catch{}
 }
 private connectionStateFile(){return path.join(privateDirectory(path.join(this.stateRoot,'connection-state')),this.id+'.json');}
 private persistFailure(){if(this.id)atomicJson(this.connectionStateFile(),{version:1,state:this.state,until:this.unavailableUntil,failures:this.failures,connectionAttempts:this.connectionAttempts,reconnects:this.reconnects});}

 private reap(){for(const [id,lease] of this.leases)if(processStart(lease.pid)!==lease.start)this.leases.delete(id);for(let i=0;i<2;i++)if(this.slots[i]?.dead&&this.slots[i]?.closed)this.slots[i]=undefined;}
 snapshot(){this.reap();return {state:this.state,connectionId:this.id,activeChannels:this.slots.filter(Boolean).length+this.leases.size,controlChannels:this.slots.filter(Boolean).length,transferChannels:this.leases.size,queued:this.queued,reconnects:this.reconnects,connectionAttempts:this.connectionAttempts,controlPids:this.slots.filter(Boolean).map(s=>s!.child.pid),controlAvailable:!!this.slots[0]&&!this.slots[0].busy&&!this.slots[0].dead,maxChannels:this.limit,retryAfterMs:Math.max(0,this.unavailableUntil-Date.now())};}
 private failure(e:unknown){if(e instanceof WdxError&&e.code==='WDX_AUTH'){this.state='auth-paused';this.persistFailure();return;}this.state='backoff';this.failures++;this.unavailableUntil=Date.now()+Math.min(60000,3000*2**Math.min(this.failures-1,5))*(0.8+Math.random()*0.4);this.persistFailure();}
 async connect(maxChannels=3,unlockPassword?:string){
  this.limit=Math.min(this.limit,channelLimit(maxChannels));
  if(this.connecting)return this.connecting;
  if(this.state==='ready'){for(let i=this.controls();i<2;i++){const slot=this.slots[i];if(slot){while(slot.busy)await pause(20);slot.close();await slot.exited;this.slots[i]=undefined;}}return;}
  if(this.closing)throw new WdxError('WDX_REMOTE_UNAVAILABLE','Connection is closing');
  if(this.state==='auth-paused'&&unlockPassword===undefined)throw new WdxError('WDX_AUTH','Authentication paused; unlock credentials or run reconnect explicitly');
  if(Date.now()<this.unavailableUntil)throw new WdxError('WDX_REMOTE_UNAVAILABLE','Connection is in backoff; no new authentication attempt was made');
  if(!this.connecting){this.connecting=(async()=>{
   this.state='connecting';
   try{
    const e=await effective(this.target);this.id=connectionId(e);this.sock=controlPath(e);
    if(unlockPassword!==undefined){const ssh=await import('./ssh');await ssh.createPasswordMaster(this.target,unlockPassword);}
    for(let i=0;i<2;i++)await reclaimClient(this.sock,this.id,i);
    this.connectionAttempts++;await ensureMaster(this.target);
    this.unavailableUntil=0;this.failures=0;
    await this.warm();this.state='ready';fs.rmSync(this.connectionStateFile(),{force:true});
   }catch(e){for(const slot of this.slots)slot?.close();this.slots.fill(undefined);this.failure(e);throw e;}
  })().finally(()=>{this.connecting=undefined;});}
  return this.connecting;
 }
 private controls(){return this.limit===3?2:1;}
 private async warm(){
  for(let i=0;i<this.controls();i++){if(this.slots[i]&&!this.slots[i]!.dead)continue;if(this.slots.filter(Boolean).length+this.leases.size>=this.limit)break;const slot=new Channel(this.target,this.sock,this.id,i);this.slots[i]=slot;await slot.execute({requestId:randomUUID(),script:':\n',args:[],timeout:10000,maxBytes:1024,lane:'control'});}
 }
 private resultFile(id:string){const directory=privateDirectory(path.join(this.stateRoot,'requests'));return path.join(directory,id+'.json');}
 async execute(c:Config,request:RemoteRequest,query=false){
  if(request.existingOnly&&this.state!=='ready')throw new WdxError('WDX_REMOTE_UNAVAILABLE','No existing healthy control channel');
  if(!request.existingOnly)await this.connect(c.runtime.maxChannels);
  const index=this.controls()===2&&request.lane==='blocking'?1:0;
  const deadline=Date.now()+request.timeout;this.queued++;
  try{
   for(;;){
    this.reap();if(this.closing)throw new WdxError('WDX_REMOTE_UNAVAILABLE','Connection closed');
    if(this.state!=='ready')throw new WdxError('WDX_REMOTE_UNAVAILABLE','Persistent connection is unavailable');
    let slot=this.slots[index];
    if(!slot){if(request.existingOnly)throw new WdxError('WDX_REMOTE_UNAVAILABLE','No existing control channel for verification');if(this.slots.filter(Boolean).length+this.leases.size<this.limit){slot=new Channel(this.target,this.sock,this.id,index);this.slots[index]=slot;}else{if(Date.now()>deadline)throw new WdxError('WDX_CHANNEL_LIMIT','Timed out waiting for a control channel');await pause(20);continue;}}
    if(slot.busy){if(Date.now()>deadline)throw new WdxError('WDX_CHANNEL_LIMIT','Timed out in control queue');await pause(20);continue;}
    slot.busy=true;
    if(!query)atomicJson(this.resultFile(request.requestId),{requestId:request.requestId,target:this.target,state:'running',slot:index,created:new Date().toISOString()});
    try{
     const result=await slot.execute(request,query);
     atomicJson(this.resultFile(request.requestId),{requestId:request.requestId,target:this.target,state:result.state,slot:query?Number(request.args[0]):index,code:result.code});
     return result;
    }catch(e){if(!query)atomicJson(this.resultFile(request.requestId),{requestId:request.requestId,target:this.target,state:'unknown',slot:index});for(const peer of this.slots)peer?.close();this.slots.fill(undefined);this.failure(e);throw e;}
    finally{slot.busy=false;}
   }
  }finally{this.queued--;}
 }
 async acquire(c:Config,token:string,pid:number){
  if(!/^[a-f0-9-]{36}$/.test(token)||!Number.isSafeInteger(pid)||pid<1)throw new WdxError('WDX_IPC','Invalid lease owner');const start=processStart(pid);if(!start)throw new WdxError('WDX_IPC','Lease owner has exited');
  await this.connect(c.runtime.maxChannels);this.queued++;const deadline=Date.now()+180000;
  try{for(;;){this.reap();if(this.closing||this.state!=='ready')throw new WdxError('WDX_REMOTE_UNAVAILABLE','Connection unavailable');
   if(this.slots.filter(Boolean).length+this.leases.size<this.limit){this.leases.set(token,{pid,start});return {connectionId:this.id,sock:this.sock};}
   if(this.limit===1&&this.slots[0]&&!this.slots[0]!.busy){const slot=this.slots[0]!;slot.close();await slot.exited;this.slots[0]=undefined;continue;}
   if(Date.now()>deadline)throw new WdxError('WDX_CHANNEL_LIMIT','Timed out waiting for transfer channel');await pause(20);
  }}finally{this.queued--;}
 }
 release(token:string){this.leases.delete(token);}
 async disconnect(){this.closing=true;const active=this.slots.filter(Boolean);for(const slot of active)slot!.close();await Promise.all(active.map(slot=>slot!.exited));this.slots.fill(undefined);this.leases.clear();try{await closeMaster(this.target,this.sock||undefined);}catch{}this.state='disconnected';}
 async reconnect(maxChannels=3){await this.disconnect();this.closing=false;this.limit=channelLimit(maxChannels);this.unavailableUntil=0;this.failures=0;this.reconnects++;if(this.id)fs.rmSync(this.connectionStateFile(),{force:true});await this.connect(maxChannels);}
 async requestStatus(c:Config,id:string){
  if(!/^[a-f0-9-]{36}$/.test(id))throw new WdxError('WDX_IPC','Invalid request ID');
  let record:{slot?:number;state?:string}={};try{record=JSON.parse(fs.readFileSync(this.resultFile(id),'utf8'));}catch{}
  if(this.state!=='ready')return {requestId:id,state:record.state??'unknown',remoteChecked:false};
  const lane=this.slots[0]&&!this.slots[0].busy?'control':this.slots[1]&&!this.slots[1].busy?'blocking':null;
  if(!lane)return {requestId:id,state:record.state??'unknown',remoteChecked:false};
  const result=await this.execute(c,{requestId:id,script:'',args:[String(record.slot??0)],timeout:10000,maxBytes:256*1024*1024,lane,existingOnly:true},true);
  return {...result,remoteChecked:true};
 }
}
