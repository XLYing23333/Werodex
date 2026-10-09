import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Config,readBoundedFile,privateDirectory,WdxError} from './core';
import {fetchArtifact} from './artifacts';
import {remote,remoteAction} from './ssh';
import {localGitRoot,gitBoundaryScript,assertGitResult} from './git';
import {checkMilestone} from './milestone';
import {PathPolicyEngine} from './policy';
import {stateUsage,checkStorageBudget,recordStorageUsage} from './storage';

function shanghaiParts(now:Date){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const v=(type:string)=>Number(parts.find(p=>p.type===type)?.value);
 return {year:v('year'),month:v('month'),day:v('day'),hour:v('hour'),minute:v('minute'),second:v('second')};
}
export function workDay(now:Date){
 const p=shanghaiParts(now),date=new Date(Date.UTC(p.year,p.month-1,p.day)-(p.hour<4?86400000:0));
 return date.toISOString().slice(0,10);
}
function stamp(now:Date){const p=shanghaiParts(now);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')} ${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}:${String(p.second).padStart(2,'0')} Asia/Shanghai`;}
function atomicText(file:string,content:string){const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,content,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
type JournalAsset={destination:string;size:number;hash:string;sourcePath:string};
function copyLocalAsset(root:string,requested:string,destination:string):JournalAsset{
 const source=path.resolve(root,requested);PathPolicyEngine.assertNotCredential(source);
 if(fs.realpathSync(source)!==source)throw new WdxError('WDX_PATH','Local asset path contains a symbolic link');
 const input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let output:number|undefined;
 try{
  const before=fs.fstatSync(input);
  if(!before.isFile())throw new WdxError('WDX_LOG','Local asset must be a regular file');
  const limit=32*1024*1024;
  if(before.size>limit)throw new WdxError('WDX_LARGE_FILE','Local asset exceeds 32 MB');
  output=fs.openSync(destination,'wx',0o600);
  const digest=createHash('sha256'),buffer=Buffer.alloc(64*1024);let size=0,n:number;
  while((n=fs.readSync(input,buffer,0,buffer.length,null))>0){
   size+=n;if(size>limit)throw new WdxError('WDX_LARGE_FILE','Local asset exceeds 32 MB');
   const chunk=buffer.subarray(0,n);digest.update(chunk);fs.writeFileSync(output,chunk);
  }
  const after=fs.fstatSync(input);
  if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new WdxError('WDX_LOG','Local asset changed while copying');
  return {destination,size,hash:digest.digest('hex'),sourcePath:source};
 }catch(e){if(output!==undefined)fs.rmSync(destination,{force:true});throw e;}
 finally{fs.closeSync(input);if(output!==undefined)fs.closeSync(output);}
}
function markdownLabel(value:string){return value.replace(/[\r\n]/g,' ').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_[\]]/g,'\\$&');}
function assetMarkdown(logs:string,asset:JournalAsset){
 const label=markdownLabel(path.basename(asset.sourcePath));
 const url=path.relative(logs,asset.destination).split(path.sep).map(part=>encodeURIComponent(part).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())).join('/');
 const extension=path.extname(asset.sourcePath).toLowerCase();
 const link=`[${label}](${url}) · ${asset.size} bytes · SHA-256 ${asset.hash}`;
 if(['.png','.jpg','.jpeg','.gif','.webp','.svg','.avif'].includes(extension))return `![${label}](${url})\n\n${link}`;
 if(['.mp4','.webm'].includes(extension))return `<video controls preload="metadata" src="${url}"></video>\n\n${link}`;
 return link;
}
export async function addLog(c:Config,root:string,entryFile:string,assetPaths:string[],now=new Date(),options:{localAssets?:string[];source?:string[]}={}){
 const localAssets=options.localAssets??[];
 if(assetPaths.length+localAssets.length>5)throw new WdxError('WDX_LOG','At most five assets can be attached to one entry');
 PathPolicyEngine.assertNotCredential(entryFile);if(fs.realpathSync(entryFile)!==path.resolve(entryFile))throw new WdxError('WDX_PATH','Unsafe entry file');const stat=fs.lstatSync(entryFile);if(!stat.isFile()||stat.size<1||stat.size>64*1024)throw new WdxError('WDX_LOG','Entry must be a regular Markdown file of at most 64 KiB');
 const entry=readBoundedFile(entryFile,65536).toString().trim();
 if(!entry||!/(?:修改内容|Changes)/i.test(entry)||!/(?:收益|Benefits)/i.test(entry))throw new WdxError('WDX_LOG','Entry needs modification and benefit sections');
 const verification=await checkMilestone(c,root,options.source);
 const usage=stateUsage(root);checkStorageBudget(c,usage.total);
 const day=workDay(now),base=privateDirectory(path.join(root,'.werodex')),logs=privateDirectory(path.join(base,'logs')),assets=privateDirectory(path.join(base,'assets')),assetDir=privateDirectory(path.join(assets,day));
 const file=path.join(logs,`logs-${day}.md`),lock=file+'.lock',created:JournalAsset[]=[],createdIndexes:string[]=[];
 let fd:number;
 try{fd=fs.openSync(lock,'wx',0o600);}catch{throw new WdxError('WDX_LOG_BUSY','Daily log is being updated');}
 try{
  for(const requested of assetPaths){
   const name=path.posix.basename(requested);if(!name||name==='.'||name==='..')throw new WdxError('WDX_PATH','Invalid asset name');
   const dst=path.join(assetDir,randomUUID()+'-'+name);
   const fetched=await fetchArtifact(c,root,requested,dst,false,((c.runtime.maxLocalStateMB??1024)*1024*1024)-usage.total-created.reduce((n,a)=>n+a.size,0));
   created.push({...fetched,sourcePath:fetched.remotePath});
  }
  for(const requested of localAssets){
   const name=path.basename(requested);if(!name||name==='.'||name==='..')throw new WdxError('WDX_PATH','Invalid asset name');
   checkStorageBudget(c,usage.total+created.reduce((n,a)=>n+a.size,0)+fs.statSync(path.resolve(root,requested)).size);
   created.push(copyLocalAsset(root,requested,path.join(assetDir,randomUUID()+'-'+name)));
  }
  const header=`# Werodex 工作日志 · ${day}\n\n`;
  const indexFile=file+'.index.json',entryDir=privateDirectory(path.join(privateDirectory(path.join(logs,'entries')),day)),entryPath=path.join(entryDir,randomUUID()+'.md');
  let index:{version:1;entries:Array<{file:string;stamp:string;title:string}>;legacy?:string;archives?:string[]}={version:1,entries:[]};
  let oldIndex:string|undefined,oldDaily:string|undefined,legacy:string|undefined;
  try{const stat=fs.lstatSync(indexFile);if(!stat.isFile()||stat.size>4*1024*1024)throw new WdxError('WDX_LOG','Daily index exceeds its bound');oldIndex=readBoundedFile(indexFile,4*1024*1024).toString();index=JSON.parse(oldIndex);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(fs.existsSync(file)){
   const stat=fs.lstatSync(file);if(!stat.isFile())throw new WdxError('WDX_LOG','Daily log is not regular');
   const handle=fs.openSync(file,'r'),prefix=Buffer.alloc(Buffer.byteLength(header));fs.readSync(handle,prefix,0,prefix.length,0);fs.closeSync(handle);if(prefix.toString()!==header)throw new WdxError('WDX_LOG','Daily header invalid');
   if(oldIndex&&stat.size<=256*1024)oldDaily=readBoundedFile(file,256*1024).toString();else legacy=path.join(logs,`logs-${day}-legacy-${randomUUID()}.md`);
  }
  const links=(directory:string)=>created.length?'\n### 可视化与输出\n\n'+created.map(asset=>assetMarkdown(directory,asset)).join('\n\n')+'\n':'';
  const checks=verification.local==='not-applicable'?'No Source scope declared; commit verification not applicable':verification.remote==='verified'?'Declared Source scope committed on both sides':'Declared local Source scope committed; remote UNVERIFIED: '+verification.reason;
  const body=`## ${stamp(now)}\n\n${entry}\n\n### Git checkpoint verification\n\n${checks}\nLocal HEAD: ${verification.localHead??'(not checked)'} · Remote HEAD: ${verification.remoteHead??'(not checked)'}\n`;
  const title=entry.split('\n').find(line=>line.trim()&&!line.trim().startsWith('#'))?.slice(0,100)??'Entry';
  const next={...index,entries:[{file:path.relative(logs,entryPath).replaceAll(path.sep,'/'),stamp:stamp(now),title},...index.entries]};
  if(legacy)next.legacy=path.basename(legacy);
  if(next.entries.length>512){const archive=path.join(logs,`logs-${day}-archive-${randomUUID()}.json`);atomicText(archive,JSON.stringify({entries:next.entries.splice(256),previous:index.archives?.[0]??null}));createdIndexes.push(archive);next.archives=[path.basename(archive)];}
  const summaries=next.entries.slice(1,50).map(item=>`- [${markdownLabel(item.title)}](${item.file}) · ${item.stamp}`).join('\n');
  const daily=header+body+links(logs)+'\n---\n\n### Earlier entries\n\n'+summaries+'\n\n[All entries](entries/'+day+'/)'+(next.archives?.length?'\n\n[Older index]('+next.archives[0]+')':'')+(next.legacy?`\n\n[Legacy daily log](${next.legacy})`:'')+'\n';
  const original=body+links(path.dirname(entryPath))+'\n---\n';
  const added=createdIndexes.reduce((n,file)=>n+fs.statSync(file).size,0)+created.reduce((sum,item)=>sum+item.size,0)+Buffer.byteLength(original)+Buffer.byteLength(daily)+Buffer.byteLength(JSON.stringify(next))-Buffer.byteLength(oldIndex??'')-Buffer.byteLength(oldDaily??'');checkStorageBudget(c,usage.total+added);
  try{
   if(legacy)fs.renameSync(file,legacy);
   atomicText(entryPath,original);atomicText(indexFile,JSON.stringify(next));atomicText(file,daily);recordStorageUsage(root,usage.total+added);
  }catch(error){fs.rmSync(entryPath,{force:true});if(oldIndex!==undefined)atomicText(indexFile,oldIndex);else fs.rmSync(indexFile,{force:true});if(legacy&&fs.existsSync(legacy)){fs.rmSync(file,{force:true});fs.renameSync(legacy,file);}else if(oldDaily!==undefined)atomicText(file,oldDaily);else fs.rmSync(file,{force:true});throw error;}
  return {log:file,entry:entryPath,verification,assets:created.map(a=>({path:a.destination,size:a.size,hash:a.hash}))};
 }catch(e){for(const asset of created)fs.rmSync(asset.destination,{force:true});for(const file of createdIndexes)fs.rmSync(file,{force:true});throw e;}
 finally{fs.closeSync(fd);fs.rmSync(lock,{force:true});}
}
export async function gitTree(c:Config,root:string,now=new Date()){
 await localGitRoot(root);
 const snapshot=(await remoteAction(c,'git.overview')).value;const m=['',snapshot.branch,snapshot.head??'',snapshot.graph,String(snapshot.statusCount),snapshot.status];
 const state=privateDirectory(path.join(root,'.werodex')),file=path.join(state,'git-tree.md');
 const clean=(s:string)=>s.replaceAll('```','` ` `').trim();
 const content=`# 远端 Git 概览\n\n- 项目：\`${c.remote.target}:${c.remote.project}\`\n- 获取时间：${stamp(now)}\n- 分支：\`${clean(m[1])||'(unknown)'}\`\n- HEAD：\`${clean(m[2])||'(no commits yet)'}\`\n- 工作区条目：${m[4]}${Number(m[4])>40?'（仅展示前 40 条）':''}\n\n## 最近提交\n\n\`\`\`text\n${clean(m[3])}\n\`\`\`\n\n## 工作区状态\n\n\`\`\`text\n${clean(m[5])||'(clean)'}\n\`\`\`\n`;
 atomicText(file,content);return {file,branch:m[1],head:m[2]||null,statusCount:Number(m[4])};
}
