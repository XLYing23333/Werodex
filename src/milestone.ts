import * as fs from 'node:fs';
import * as path from 'node:path';
import {Config,run,WdxError} from './core';
import {PathPolicyEngine} from './policy';
import {localGitRoot,assertGitResult} from './git';
import {remote} from './ssh';
import {existingConnection} from './daemon';
export function dirtyPaths(porcelain:string){
 const records=porcelain.split('\0'),out=new Set<string>();
 for(let i=0;i<records.length;i++){const record=records[i];if(!record)continue;out.add(record.slice(3));if(/[RC]/.test(record.slice(0,2))&&records[i+1])out.add(records[++i]);}
 return [...out];
}
export async function localDirtySource(c:Config,root:string,paths?:string[]){
 await localGitRoot(root);const status=await run('git',['--literal-pathspecs','status','--porcelain','-z','--untracked-files=all',...(paths?.length?['--',...paths]:[])],{cwd:root});assertGitResult(status);
 const policy=new PathPolicyEngine(root,c),out:string[]=[];
 for(const p of dirtyPaths(status.stdout)){let size=0;try{const st=fs.lstatSync(path.join(root,p));if(!st.isFile())continue;size=st.size;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if((await policy.classify(p,size)).kind==='SOURCE')out.push(p);
 }
 return out;
}
export async function checkMilestone(c:Config,root:string,paths?:string[]){
 if(!paths?.length)return {local:'not-applicable',remote:'not-applicable',localHead:null,remoteHead:null,reason:'No Source scope declared'};
 for(const p of paths)if(PathPolicyEngine.isNeverSource(p))throw new WdxError('WDX_PATH','Not allowed Source: '+p);
 const local=await localDirtySource(c,root,paths);
 if(local.length)throw new WdxError('WDX_CHECKPOINT_REQUIRED','Uncommitted local Source; run checkpoint before logging: '+local.join(', '));
 const head=await run('git',['rev-parse','--verify','HEAD'],{cwd:root});const localHead=head.code===0?head.stdout.trim():null;
 const connection=await existingConnection(c);
 if(!connection||connection.state!=='ready'||!connection.controlChannels)return {local:'verified',localHead,remoteHead:null,remote:'unverified',reason:'No existing healthy remote control channel'};
 let result;
 const filtered=PathPolicyEngine.remoteDirtySourceScript(c).replace('git status --porcelain -z --untracked-files=all |','git --literal-pathspecs status --porcelain -z --untracked-files=all -- '+paths.map(p=>"'"+p.replace(/'/g,"'\\''")+"'").join(' ')+' |');
 const script=filtered+`printf 'HEAD %s\\n' "$(git -C "$1" rev-parse HEAD 2>/dev/null || true)"\n`;
 try{result=await remote(c,script,[c.remote.project],60000,8*1024*1024,{existingOnly:true});}catch(e){return {local:'verified',localHead,remoteHead:null,remote:'unverified',reason:(e as Error).message};}
 assertGitResult(result);const lines=result.stdout.trim().split('\n'),remoteHead=lines.find(line=>line.startsWith('HEAD '))?.slice(5)||null;const remotePaths=lines.filter(line=>line&&!line.startsWith('HEAD ')).map(p=>Buffer.from(p,'base64').toString());
 if(remotePaths.length)throw new WdxError('WDX_CHECKPOINT_REQUIRED','Uncommitted remote Source; run checkpoint before logging: '+remotePaths.join(', '));
 return {local:'verified',localHead,remoteHead,remote:'verified'};
}
