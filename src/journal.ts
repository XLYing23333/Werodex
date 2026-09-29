import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Config,privateDirectory,WdxError} from './core';
import {fetchArtifact,FetchedAsset} from './artifacts';
import {remote} from './ssh';

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
export async function addLog(c:Config,root:string,entryFile:string,assetPaths:string[],now=new Date()){
 if(assetPaths.length>5)throw new WdxError('WDX_LOG','At most five assets can be attached to one entry');
 const stat=fs.lstatSync(entryFile);if(!stat.isFile()||stat.size<1||stat.size>64*1024)throw new WdxError('WDX_LOG','Entry must be a regular Markdown file of at most 64 KiB');
 const entry=fs.readFileSync(entryFile,'utf8').trim();
 if(!entry||!/(?:修改内容|Changes)/i.test(entry)||!/(?:收益|Benefits)/i.test(entry))throw new WdxError('WDX_LOG','Entry needs modification and benefit sections');
 const day=workDay(now),base=privateDirectory(path.join(root,'.werodex')),logs=privateDirectory(path.join(base,'logs')),assets=privateDirectory(path.join(base,'assets')),assetDir=privateDirectory(path.join(assets,day));
 const file=path.join(logs,`logs-${day}.md`),lock=file+'.lock',created:FetchedAsset[]=[];
 let fd:number;
 try{fd=fs.openSync(lock,'wx',0o600);}catch{throw new WdxError('WDX_LOG_BUSY','Daily log is being updated');}
 try{
  for(const requested of assetPaths){
   const name=path.posix.basename(requested);if(!name||name==='.'||name==='..')throw new WdxError('WDX_PATH','Invalid asset name');
   const dst=path.join(assetDir,randomUUID()+'-'+name);
   created.push(await fetchArtifact(c,root,requested,dst));
  }
  let old='';try{const st=fs.lstatSync(file);if(!st.isFile())throw new WdxError('WDX_LOG','Daily log is not a regular file');old=fs.readFileSync(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const header=`# Werodex 工作日志 · ${day}\n\n`;
  if(old&&!old.startsWith(header))throw new WdxError('WDX_LOG','Daily log header is invalid');
  const links=created.length?'\n### 可视化与输出\n\n'+created.map(a=>`- [${path.basename(a.remotePath)}](${path.relative(logs,a.destination).replaceAll(path.sep,'/')}) · ${a.size} bytes · SHA-256 ${a.hash}`).join('\n')+'\n':'';
  const block=`## ${stamp(now)}\n\n${entry}\n${links}\n---\n\n`;
  atomicText(file,header+block+(old?old.slice(header.length):''));
  return {log:file,assets:created.map(a=>({path:a.destination,size:a.size,hash:a.hash}))};
 }catch(e){for(const asset of created)fs.rmSync(asset.destination,{force:true});throw e;}
 finally{fs.closeSync(fd);fs.rmSync(lock,{force:true});}
}
export async function gitTree(c:Config,root:string,now=new Date()){
 const script=`set -e\ncd "$1"\nprintf 'BRANCH\\n'\nbranch=$(git symbolic-ref --short HEAD || true); printf '%s\\n' "$branch"\nprintf 'HEAD\\n'\nhead=$(git rev-parse HEAD 2>/dev/null || true); printf '%s\\n' "$head"\nprintf 'LOG\\n'\nif git rev-parse --verify HEAD >/dev/null 2>&1; then git log --graph --oneline --decorate -12; else printf '(no commits yet)\\n'; fi\nprintf 'STATUS_COUNT\\n'\ngit status --porcelain --untracked-files=normal | wc -l\nprintf 'STATUS\\n'\ngit status --short --untracked-files=normal | head -40\n`;
 const r=await remote(c,script,[c.remote.project],60000,64*1024);
 if(r.code)throw new WdxError('WDX_GIT',r.stderr||'Cannot inspect remote Git tree');
 const m=/^BRANCH\n([^\n]*)\nHEAD\n([^\n]*)\nLOG\n([\s\S]*?)STATUS_COUNT\n(\d+)\nSTATUS\n([\s\S]*)$/.exec(r.stdout);
 if(!m)throw new WdxError('WDX_GIT','Invalid remote Git tree response');
 const state=privateDirectory(path.join(root,'.werodex')),file=path.join(state,'git-tree.md');
 const clean=(s:string)=>s.replaceAll('```','` ` `').trim();
 const content=`# 远端 Git 概览\n\n- 项目：\`${c.remote.target}:${c.remote.project}\`\n- 获取时间：${stamp(now)}\n- 分支：\`${clean(m[1])||'(unknown)'}\`\n- HEAD：\`${clean(m[2])||'(no commits yet)'}\`\n- 工作区条目：${m[4]}${Number(m[4])>40?'（仅展示前 40 条）':''}\n\n## 最近提交\n\n\`\`\`text\n${clean(m[3])}\n\`\`\`\n\n## 工作区状态\n\n\`\`\`text\n${clean(m[5])||'(clean)'}\n\`\`\`\n`;
 atomicText(file,content);return {file,branch:m[1],head:m[2]||null,statusCount:Number(m[4])};
}
