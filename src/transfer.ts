import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Config,atomicJson,privateDirectory,readBoundedFile,run,WdxError} from './core';
import {PathPolicyEngine} from './policy';
import {remoteAction,rsyncSsh} from './ssh';
import {withTransferLease} from './daemon';
import {withWorkspaceLock} from './lock';
import {checkStorageBudget,storageStats,invalidateUsage} from './storage';
export type Content={size:number;hash:string};
type Item={path:string;source:Content;target:Content|null};
type Saved=Item&{side:'local'|'remote';old?:Content|null;published?:boolean|null;state?:string;archived?:boolean};
type Record={version:1;id:string;root:string;workspaceId:string;remote:Config['remote'];created:string;state:string;files:Saved[]};
const same=(a:Content|null|undefined,b:Content|null|undefined)=>a?.hash===b?.hash&&a?.size===b?.size;
function directory(root:string,id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new WdxError('WDX_BACKUP','Invalid backup ID');return privateDirectory(path.join(privateDirectory(path.join(privateDirectory(path.join(root,'.werodex')),'backup')),id));}
function durable(file:string){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const parent=fs.openSync(path.dirname(file),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
function metadata(root:string,record:Record){invalidateUsage(root);const file=path.join(directory(root,record.id),'record.json');atomicJson(file,record);durable(file);}
async function localAction(c:Config,root:string,name:string,payload:any){const state=privateDirectory(path.join(privateDirectory(path.join(root,'.werodex')),'transfer'));const r=await run('python3',['-B',path.join(__dirname,'remote-worker.py'),'oneshot'],{input:JSON.stringify({action:name,payload,root,policy:PathPolicyEngine.policyData(c),state}),timeout:120000});if(r.code){const code=r.stderr.match(/(WDX_[A-Z_]+):/)?.[1];throw new WdxError(code??'WDX_TRANSFER',r.stderr);}return JSON.parse(r.stdout).value;}
async function action(c:Config,root:string,side:'local'|'remote',name:string,payload:any){return side==='local'?localAction(c,root,name,payload):(await remoteAction(c,name,payload,{timeout:120000})).value;}
async function rsync(c:Config,from:string,to:string,files:string[],budgetRoot?:string){await withTransferLease(c,async sock=>{const controller=new AbortController();let overflow=false;const timer=budgetRoot?setInterval(()=>{try{checkStorageBudget(c,storageStats(budgetRoot).total);}catch{overflow=true;controller.abort();}},25):undefined;try{const r=await run('rsync',['-s','-a','--ignore-times','--no-links','--no-devices','--no-specials','--no-perms','--from0','--files-from=-',...(budgetRoot?['--max-size='+Math.max(0,Math.floor((c.runtime.maxLocalStateMB??1024)*1024*1024)-storageStats(budgetRoot).total)]:[]),'-e',rsyncSsh(sock),'--',from+'/',to+'/'],{input:files.join('\0')+'\0',timeout:180000,maxBytes:2*1024*1024,signal:controller.signal});if(overflow)throw new WdxError('WDX_STORAGE_LIMIT','Staging exceeded local state quota');if(budgetRoot)checkStorageBudget(c,storageStats(budgetRoot).total);if(r.code)throw new WdxError('WDX_RSYNC',r.stderr||r.stdout);}finally{if(timer)clearInterval(timer);}});}
async function digest(file:string):Promise<Content>{const before=fs.statSync(file,{bigint:true}),hash=createHash('sha256');let size=0;for await(const chunk of fs.createReadStream(file)){size+=chunk.length;hash.update(chunk);}const after=fs.statSync(file,{bigint:true});if(before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(size)!==before.size)throw new WdxError('WDX_CONCURRENT_CHANGE','Backup changed while hashing');return {size,hash:hash.digest('hex')};}
async function archive(c:Config,root:string,record:Record,only?:{side:'local'|'remote';paths:string[]}){
 const base=directory(root,record.id);
 for(const side of ['local','remote'] as const){
  const items=record.files.filter(x=>x.side===side&&(!only||(only.side===side&&only.paths.includes(x.path))));if(!items.length)continue;
  const inspected=await action(c,root,side,'transfer.inspect',{id:record.id,files:items});
  for(const info of inspected.files){const item=items.find(x=>x.path===info.path)!;if(item.archived&&!same(item.old,info.old))throw new WdxError('WDX_CONCURRENT_CHANGE','Displaced file changed after archive; remote recovery retained');Object.assign(item,info);metadata(root,record);
   if(!info.old)continue;
   if(item.archived){const savedRoot=path.join(base,side);PathPolicyEngine.assertSafeTransferPath(savedRoot,item.path);if(!same(await digest(path.join(savedRoot,item.path)),item.old))throw new WdxError('WDX_BACKUP','Archived snapshot changed; remote recovery retained');continue;}
   checkStorageBudget(c,storageStats(root).total+info.old.size);
   let parent=base;for(const part of [side,...item.path.split('/').slice(0,-1)])parent=privateDirectory(path.join(parent,part));const dst=path.join(parent,path.basename(item.path));if(fs.existsSync(dst)){PathPolicyEngine.assertSafeTransferPath(path.join(base,side),item.path);if(!same(await digest(dst),info.old))throw new WdxError('WDX_BACKUP','Existing snapshot differs; preserve both recovery locations for inspection');item.archived=true;metadata(root,record);continue;}
   const temp=dst+'.'+randomUUID()+'.part';
   try{
    const src=path.join(side==='local'?root:c.remote.project,'.werodex','transfer',record.id,info.oldFolder??'old',item.path);
    if(side==='remote'){
     // Monitor in-flight downloads as well as the advertised size; preserve remote recovery on failure.
     let overflow=false;const controller=new AbortController();const available=Math.floor((c.runtime.maxLocalStateMB??1024)*1024*1024)-storageStats(root).total;
     const timer=setInterval(()=>{try{checkStorageBudget(c,storageStats(root).total);}catch{overflow=true;controller.abort();}},25);
     try{await withTransferLease(c,async sock=>{const r=await run('rsync',['-s','-a','--ignore-times','--no-links','--no-devices','--no-specials','--no-perms','--max-size='+available,'-e',rsyncSsh(sock),'--',c.remote.target+':'+src,temp],{timeout:180000,signal:controller.signal});if(overflow)throw new WdxError('WDX_STORAGE_LIMIT','Backup download exceeded quota');if(r.code)throw new WdxError('WDX_BACKUP_PENDING',r.stderr);});}finally{clearInterval(timer);}checkStorageBudget(c,storageStats(root).total);if(overflow)throw new WdxError('WDX_STORAGE_LIMIT','Backup download exceeded quota');
    }else{
     const input=fs.openSync(src,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),output=fs.openSync(temp,'wx',0o600),buffer=Buffer.alloc(65536);let size=0;
     try{let n;while((n=fs.readSync(input,buffer,0,buffer.length,null))){size+=n;checkStorageBudget(c,storageStats(root).total+n);fs.writeSync(output,buffer,0,n);}if(size!==info.old.size)throw new WdxError('WDX_CONCURRENT_CHANGE','Backup size changed');}finally{fs.closeSync(input);fs.closeSync(output);}
    }
    PathPolicyEngine.assertSafeTransferPath(path.dirname(temp),path.basename(temp));
    if(!same(await digest(temp),info.old))throw new WdxError('WDX_CONCURRENT_CHANGE','Backup changed during archive');
    fs.chmodSync(temp,0o600);durable(temp);fs.renameSync(temp,dst);durable(dst);item.archived=true;metadata(root,record);
   }finally{fs.rmSync(temp,{force:true});}
  }
  // Only verified, durably recorded local archives authorize deleting displaced remote files.
  const clean=items.filter(x=>x.published===true&&(!x.old||x.archived));if(clean.length)await action(c,root,side,'transfer.cleanup',{id:record.id,files:clean});
 }
}
export async function publishFiles(c:Config,root:string,direction:'sync'|'pull',files:string[],source:Map<string,Content>,target:Map<string,Content>,id:string=randomUUID()){
 if(!files.length)return undefined;
 const side=direction==='sync'?'remote':'local',items:Saved[]=files.map(p=>({path:p,source:source.get(p)!,target:target.get(p)??null,side}));
 for(const item of items){PathPolicyEngine.assertSafeTransferPath(root,item.path);if(!item.source||PathPolicyEngine.isNeverSource(item.path))throw new WdxError('WDX_TRANSFER_POLICY','Invalid Source transfer');}
 if(fs.existsSync(path.join(root,'.werodex','backup',id,'record.json')))throw new WdxError('WDX_REQUEST_UNKNOWN','Backup transaction already exists; inspect it instead of replaying publication');
 const record:Record={version:1,id,root:fs.realpathSync(root),workspaceId:c.workspaceId,remote:c.remote,created:new Date().toISOString(),state:'prepared',files:items};
 checkStorageBudget(c,storageStats(root).total+items.reduce((n,x)=>n+(x.target?.size??0)+(side==='local'?x.source.size:0),0)+16384);metadata(root,record);
 try{
  const prepared=await action(c,root,side,'transfer.prepare',{id,files:items});
  const incoming=path.join(prepared.directory,'incoming');
  await rsync(c,direction==='sync'?root:c.remote.target+':'+c.remote.project,direction==='sync'?c.remote.target+':'+incoming:incoming,files,side==='local'?root:undefined);
  record.state='publishing';metadata(root,record);
  const result=await action(c,root,side,'transfer.commit',{id,files:items});
  for(const info of result.files)Object.assign(items.find(x=>x.path===info.path)!,info);
  record.state=result.conflict?'conflict':'archiving';metadata(root,record);await archive(c,root,record);
  if(result.conflict)throw new WdxError('WDX_CONFLICT',`Concurrent target edit; recovery snapshots: .werodex/backup/${id}. Inspect backup list before restoring; Manifest was not advanced.`);
  record.state='complete';metadata(root,record);return id;
 }catch(e){if(record.state!=='conflict')record.state='pending';metadata(root,record);throw new WdxError((e as WdxError).code??'WDX_BACKUP_PENDING',`${(e as Error).message} Transaction ${id}; recovery record: .werodex/backup/${id}/record.json. Publication must not be replayed.`);}
}
function readRecord(c:Config,root:string,id:string){const file=path.join(directory(root,id),'record.json');const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>20*1024*1024)throw new WdxError('WDX_BACKUP','Invalid backup record');const r=JSON.parse(readBoundedFile(file,20*1024*1024).toString()) as Record;if(r.version!==1||r.id!==id||r.root!==fs.realpathSync(root)||r.workspaceId!==c.workspaceId||r.remote?.target!==c.remote.target||r.remote?.project!==c.remote.project||!Array.isArray(r.files)||r.files.some(x=>!['local','remote'].includes(x.side)||PathPolicyEngine.isNeverSource(x.path)))throw new WdxError('WDX_BACKUP','Backup belongs to another workspace or is invalid');return r;}
export function listBackups(root:string){
 const base=path.join(root,'.werodex','backup');if(!fs.existsSync(base))return [];privateDirectory(base,false);
 return fs.readdirSync(base).filter(id=>/^[a-f0-9-]{36}$/.test(id)).sort((a,b)=>fs.lstatSync(path.join(base,b)).mtimeMs-fs.lstatSync(path.join(base,a)).mtimeMs).slice(0,200).map(id=>{
  try{const file=path.join(directory(root,id),'record.json'),r=JSON.parse(readBoundedFile(file,20*1024*1024).toString());if(!Array.isArray(r.files))throw Error();return {id,created:r.created,state:r.state,files:r.files.length,paths:r.files.slice(0,10).map((x:Saved)=>x.path),pathsLimited:r.files.length>10,sides:[...new Set(r.files.map((x:Saved)=>x.side))]};}
  catch{return {id,state:'invalid'};}
 });
}
export async function restoreBackup(c:Config,root:string,id:string,side:'local'|'remote',paths:string[]){return withWorkspaceLock(root,async()=>{
 paths=[...new Set(paths)];if(!paths.length)throw new WdxError('WDX_USAGE','backup restore requires explicit paths');const record=readRecord(c,root,id);if(paths.some(p=>!record.files.some(x=>x.path===p&&x.side===side)))throw new WdxError('WDX_BACKUP','Requested scope is not in this backup');await archive(c,root,record,{side,paths});
 const selected=paths.map(p=>{const item=record.files.find(x=>x.path===p&&x.side===side);if(!item?.old||!item.archived||item.published!==true)throw new WdxError('WDX_BACKUP','No restorable displaced version: '+p);return item;});
 for(const item of selected){const base=path.join(directory(root,id),side);PathPolicyEngine.assertSafeTransferPath(base,item.path);const content=await digest(path.join(base,item.path));if(!same(content,item.old))throw new WdxError('WDX_BACKUP','Backup content changed');}
 const inventory=side==='local'?await new PathPolicyEngine(root,c).sourceFiles({paths,full:true}):(await remoteAction(c,'scan',{paths,full:true})).value.files.reduce((m:Map<string,Content>,x:any)=>m.set(x.path,{size:x.size,hash:x.hash}),new Map<string,Content>());
 for(const item of selected){if(!same(inventory.get(item.path),item.source))throw new WdxError('WDX_CONCURRENT_CHANGE','Restore target has subsequent edits: '+item.path);}
 // Use the same atomic publication protocol; copy the snapshot into staging, never edit live Source directly.
 const nextId=randomUUID(),next:Record={...record,id:nextId,created:new Date().toISOString(),state:'prepared',files:selected.map(x=>({path:x.path,source:x.old!,target:x.source,side}))};
 checkStorageBudget(c,storageStats(root).total+selected.reduce((n,x)=>n+x.source.size+x.old!.size,0)+16384);metadata(root,next);
 try{const prep=await action(c,root,side,'transfer.prepare',{id:nextId,files:next.files});const incoming=path.join(prep.directory,'incoming'),saved=path.join(directory(root,id),side);
  if(side==='remote')await rsync(c,saved,c.remote.target+':'+incoming,paths);else for(const p of paths)fs.copyFileSync(path.join(saved,p),path.join(incoming,p),fs.constants.COPYFILE_EXCL);
  next.state='publishing';metadata(root,next);const result=await action(c,root,side,'transfer.commit',{id:nextId,files:next.files});for(const info of result.files)Object.assign(next.files.find(x=>x.path===info.path)!,info);next.state=result.conflict?'conflict':'archiving';metadata(root,next);await archive(c,root,next);if(result.conflict)throw new WdxError('WDX_CONFLICT','Restore target changed; snapshots retained');next.state='complete';metadata(root,next);return {id:nextId,restored:paths};
 }catch(e){if(next.state!=='conflict')next.state='pending';metadata(root,next);throw e;}
 });}
