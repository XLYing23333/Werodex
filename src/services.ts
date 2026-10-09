import * as fs from 'node:fs';
import * as path from 'node:path';
import {Config,readBoundedFile,WdxError} from './core';
import {PathPolicyEngine} from './policy';
import {fileOperation,verifyEditScope} from './files';
import {checkpoint} from './checkpoint';
import {addLog,gitTree} from './journal';
import {sync} from './sync';
import {job,jobs,startJob,waitJob,logs,killJob} from './jobs';
import {fetchArtifact} from './artifacts';
import {remoteAction} from './ssh';
import {rpc,ensureDaemon} from './daemon';
export async function finish(c:Config,root:string,message:string,entry:string,paths:string[],assets:string[]=[],localAssets:string[]=[]){
 PathPolicyEngine.assertNotCredential(entry);if(assets.length+localAssets.length>5)throw new WdxError('WDX_LOG','At most five assets');for(const file of [...assets,...localAssets])PathPolicyEngine.assertNotCredential(file);const stat=fs.lstatSync(entry);if(!stat.isFile()||stat.size>65536)throw new WdxError('WDX_LOG','Regular bounded entry required');const content=readBoundedFile(entry,65536).toString();if(!/(?:Changes|修改内容)/i.test(content)||!/(?:Benefits|收益)/i.test(content))throw new WdxError('WDX_LOG','Changes and Benefits required');
 if(!paths.length)throw new WdxError('WDX_USAGE','finish requires this milestone Source paths');await verifyEditScope(root,paths);
 const committed=await checkpoint(c,root,message,paths);const tree=await gitTree(c,root);const log=await addLog(c,root,entry,assets,new Date(),{localAssets,source:paths});
 for(const name of paths){const key=require('node:crypto').createHash('sha256').update(name).digest('hex');fs.rmSync(path.join(root,'.werodex/edits',key+'.json'),{force:true});}
 return {checkpoint:committed,gitTree:tree.file,...log};
}
export async function service(c:Config,root:string,name:string,input:any){
 if(name.startsWith('file_'))return fileOperation(c,root,name.slice(5),input);
 if(name==='program_exec')return remoteAction(c,'program',{argv:input.argv},{timeout:input.timeout??60000,maxBytes:input.maxBytes??12288});
 if(name==='job_run')return {id:await startJob(c,input.argv)};
 if(name==='job_status')return input.id?job(c,input.id):{jobs:await jobs(c)};
 if(name==='job_wait')return waitJob(c,input.id,input.timeout??3600);
 if(name==='job_logs')return {text:await logs(c,input.id,{cursor:input.cursor,maxBytes:input.maxBytes??65536}),untrusted:true};
 if(name==='job_kill'){await killJob(c,input.id);return {id:input.id};}
 if(name==='sync')return sync(c,root,input.direction??'sync',{paths:input.paths,full:input.full});
 if(name==='status'){await ensureDaemon();return rpc({op:'status',target:c.remote.target,config:c});}
 if(name==='finish')return finish(c,root,input.message,path.resolve(root,input.entry),input.paths,input.assets??[],input.localAssets??[]);
 if(name==='fetch')return fetchArtifact(c,root,input.path);
 throw new WdxError('WDX_USAGE','Unknown native tool');
}
