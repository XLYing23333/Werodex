import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Config,privateDirectory,run,shQuote,WdxError} from './core';
import {PathPolicyEngine} from './policy';
import {effective,controlPath,remote} from './ssh';
import {withLease} from './daemon';

export type FetchedAsset={destination:string;size:number;hash:string;remotePath:string};
export async function fetchArtifact(c:Config,root:string,requested:string,destination?:string,allowLarge=false):Promise<FetchedAsset>{
 return withLease(c,async()=>{
  const rp=PathPolicyEngine.safeRemotePath(c.remote.project,requested);
  if(rp.split('/').some(x=>['datasets','data','pretrained'].includes(x)))throw new WdxError('WDX_PATH','Dataset and pretrained bulk fetch is forbidden');
  const check=await remote(c,'set -e; p=$(realpath -e -- "$1"); case "$p" in "$2"/*) ;; *) exit 5;; esac; test "$p" = "$1"; test -f "$p"; stat -c%s -- "$p"; sha256sum -- "$p"',[rp,c.remote.project]);
  if(check.code)throw new WdxError('WDX_PATH','Artifact must be a regular file inside the remote project without symbolic links');
  const [sizeLine,hashLine]=check.stdout.trim().split('\n'),size=Number(sizeLine),hash=hashLine?.split(' ')[0];
  if(!Number.isSafeInteger(size)||size<0||!/^[a-f0-9]{64}$/.test(hash??''))throw new WdxError('WDX_FETCH','Invalid remote artifact metadata');
  const relative=path.posix.relative(c.remote.project,rp),policy=await new PathPolicyEngine(root,c).classify(relative,size,true);
  if(policy.kind==='IGNORED')throw new WdxError('WDX_PATH','Artifact excluded by path policy');
  if(size>32*1024*1024&&!allowLarge)throw new WdxError('WDX_LARGE_FILE',`Artifact is ${size} bytes; maximum is 32 MB`);
  const dst=destination??PathPolicyEngine.artifactDestination(root,relative);
  if(destination){
   const base=privateDirectory(path.join(root,'.werodex'));
   if(!path.resolve(dst).startsWith(base+path.sep))throw new WdxError('WDX_PATH','Asset destination must stay under .werodex');
   let at=path.dirname(dst);const dirs:string[]=[];
   while(at!==base){dirs.push(at);at=path.dirname(at);if(!at.startsWith(base))throw new WdxError('WDX_PATH','Unsafe asset destination');}
   for(const dir of dirs.reverse())privateDirectory(dir);
   if(fs.existsSync(dst))throw new WdxError('WDX_FETCH_EXISTS','Artifact destination already exists: '+dst);
  }
  const tmp=dst+'.'+randomUUID()+'.part';
  try{
   const e=await effective(c.remote.target);
   const r=await run('rsync',['-s','-a','-e',`ssh -o ControlMaster=auto -o ControlPath=${shQuote(controlPath(e))}`,'--',c.remote.target+':'+rp,tmp],{timeout:180000});
   if(r.stderr.includes('Master refused session request'))throw new WdxError('WDX_SSH_MASTER','SSH Master refused fetch channel');
   if(r.code)throw new WdxError('WDX_FETCH',r.stderr||r.stdout);
   const stat=fs.lstatSync(tmp);if(!stat.isFile()||stat.size!==size)throw new WdxError('WDX_FETCH','Artifact changed during download or is not a regular file');
   const digest=createHash('sha256');for await(const chunk of fs.createReadStream(tmp))digest.update(chunk);
   if(digest.digest('hex')!==hash)throw new WdxError('WDX_FETCH','Artifact hash changed during download');
   try{fs.linkSync(tmp,dst);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new WdxError('WDX_FETCH_EXISTS','Artifact destination already exists: '+dst);throw e;}
   return {destination:dst,size,hash:hash!,remotePath:rp};
  }finally{fs.rmSync(tmp,{force:true});}
 });
}
