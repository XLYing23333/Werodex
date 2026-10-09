import {spawn} from 'node:child_process';
import {Config,WdxError,shQuote} from './core';
import {remote,remoteAction,masterClientArgs} from './ssh';
import {filterOutput} from './output';
import {withTransferLease} from './daemon';
export type Job={id:string;command:string;started:string;pid:number|null;status:'running'|'completed'|'failed'|'unknown';exitCode:number|null;logPath:string;workspace:string;runtime:string};
function valid(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new WdxError('WDX_JOB','Invalid job ID');}
export async function startJob(c:Config,words:string[]){if(!words.length||words.some(x=>x.includes('\0'))||Buffer.byteLength(JSON.stringify(words))>512*1024)throw new WdxError('WDX_USAGE','Command argv required');return (await remoteAction(c,'job.start',{workspace:c.workspaceId,argv:words,limit:Math.floor(c.runtime.maxLogSizeMB*1024*1024),runtime:c.runtime.tmp,retentionDays:c.runtime.logRetentionDays})).value.id as string;}
export async function jobs(c:Config):Promise<Job[]>{return (await remoteAction(c,'job.list',{workspace:c.workspaceId,limit:200})).value.jobs;}
export async function job(c:Config,id:string):Promise<Job>{valid(id);return (await remoteAction(c,'job.status',{workspace:c.workspaceId,id})).value;}
export async function waitJob(c:Config,id:string,timeout=3600){valid(id);if(!Number.isFinite(timeout)||timeout<0||timeout>7*86400)throw new WdxError('WDX_JOB','Invalid timeout');return (await remoteAction(c,'job.wait',{workspace:c.workspaceId,id,timeout},{lane:'blocking',timeout:Math.max(10000,Math.floor(timeout*1000)+5000)})).value as Job&{timedOut?:boolean};}
export type LogOptions={raw?:boolean;errors?:boolean;context?:number;tail?:number;cursor?:number;maxBytes?:number};
export async function streamLogs(c:Config,id:string,onData:(data:Buffer)=>Promise<void>,opts:LogOptions={}){
 valid(id);const limit=opts.maxBytes??(opts.raw?Math.min(256*1024*1024,Math.floor(c.runtime.maxLogSizeMB*1024*1024)):65536);
 if(!Number.isSafeInteger(limit)||limit<1||limit>256*1024*1024||opts.cursor!==undefined&&(!Number.isSafeInteger(opts.cursor)||opts.cursor<0))throw new WdxError('WDX_USAGE','Invalid log byte limit or cursor');
 return (await remoteAction(c,'job.logs',{workspace:c.workspaceId,id,maxBytes:limit,cursor:opts.cursor},{maxBytes:limit,onData:async(kind,data)=>{if(kind==='O')await onData(data);}})).value;
}
export async function logs(c:Config,id:string,opts:LogOptions={}){
 const parts:Buffer[]=[];let size=0;await streamLogs(c,id,async data=>{size+=data.length;if(size>8*1024*1024)throw new WdxError('WDX_OUTPUT_LIMIT','Use streamLogs for large raw logs');parts.push(data);},{...opts,maxBytes:opts.maxBytes??(opts.raw?8*1024*1024:65536)});
 const text=Buffer.concat(parts).toString();if(opts.raw)return text;let lines=text.split('\n');
 if(opts.errors){const selected=new Set<number>();for(let i=0;i<lines.length;i++)if(/error|fatal|traceback|exception|failed/i.test(lines[i]))for(let n=Math.max(0,i-(opts.context??0));n<=Math.min(lines.length-1,i+(opts.context??0));n++)selected.add(n);lines=[...selected].sort((a,b)=>a-b).map(i=>lines[i]);}else if(opts.tail)lines=lines.slice(-opts.tail);
 return filterOutput(lines.join('\n'));
}
export async function killJob(c:Config,id:string){valid(id);await remoteAction(c,'job.kill',{workspace:c.workspaceId,id});}
export async function interactive(c:Config,what:'shell'|'attach',id?:string){if(what==='attach')valid(id!);return withTransferLease(c,async sock=>new Promise<number>((resolve,reject)=>{const command=what==='shell'?`cd ${shQuote(c.remote.project)} && exec bash`:`tmux attach -t ${shQuote('wdx-'+id)}`;const child=spawn('ssh',['-tt',...masterClientArgs(sock),c.remote.target,command],{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>resolve(code??1));}));}
export async function pruneJobs(c:Config){await remote(c,`base="$HOME/.local/state/werodex/jobs/${c.workspaceId}"; test -d "$base" || exit 0; find "$base" -mindepth 2 -maxdepth 2 -name exit -mmin +${Math.max(1,c.runtime.logRetentionDays)*1440} -printf '%h\\n' | while IFS= read -r dir; do rm -rf -- "$dir"; done`);}
