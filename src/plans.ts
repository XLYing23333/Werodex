import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDirectory,WdxError} from './core';

export function planDirectory(root:string){return privateDirectory(path.join(privateDirectory(path.join(root,'.werodex')),'plan'));}
const reserved=new Set(['project-tree.md','git-tree.md','entry.md','README.md','AGENTS.md']);
function textFile(file:string){const st=fs.lstatSync(file);if(!st.isFile()||st.size>4*1024*1024)throw new WdxError('WDX_PLAN','Expected a regular Markdown file of at most 4 MiB: '+file);return {content:fs.readFileSync(file,'utf8'),mode:st.mode&0o777};}
function relativeLink(link:string,from:string,to:string,moves:Map<string,string>){
 if(!link||/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(link))return link;
 const m=/^([^?#]*)([?#].*)?$/.exec(link)!;let decoded:string;
 try{decoded=decodeURIComponent(m[1].replace(/\\([ ()])/g,'$1'));}catch{return link;}
 const target=path.resolve(path.dirname(from),decoded),next=moves.get(target)??target;
 if(from===to&&next===target)return link;
 const rel=path.relative(path.dirname(to),next).split(path.sep).map(x=>encodeURIComponent(x).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16))).join('/');
 return rel+(m[2]??'');
}
// Change link destinations only, not prose, fenced code or inline code examples.
function rewriteLinks(content:string,from:string,to:string,moves:Map<string,string>){
 let fence:string|null=null;
 return content.split(/(?<=\n)/).map(line=>{
  const marker=/^\s*(`{3,}|~{3,})/.exec(line);if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;return line;}if(fence)return line;
  return line.split(/(`+[^`]*`+)/g).map((part,i)=>i%2?part:part
   .replace(/(!?\[[^\]\n]*(?:\\\][^\]\n]*)*\]\(\s*)(?:<([^>\n]+)>|((?:\\.|[^\s()]|\([^()]*\))+))(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?(\s*\))/g,(_all,lead,angle,plain,title,tail)=>lead+(angle!==undefined?'<'+relativeLink(angle,from,to,moves)+'>':relativeLink(plain,from,to,moves))+(title??'')+tail)
   .replace(/^(\s*\[[^\]]+\]:\s*)(?:<([^>]+)>|(\S+))(.*)$/,(_all,lead,angle,plain,tail)=>lead+(angle!==undefined?'<'+relativeLink(angle,from,to,moves)+'>':relativeLink(plain,from,to,moves))+tail)
   .replace(/(\b(?:href|src)\s*=\s*)(["'])([^"']+)\2/g,(_all,lead,quote,url)=>lead+quote+relativeLink(url,from,to,moves)+quote)).join('');
 }).join('');
}
export function migratePlans(root:string,files:string[],dryRun=false){
 if(!files.length)throw new WdxError('WDX_USAGE','plan migrate [--dry-run] -- .werodex/FILE.md...');
 const base=path.join(root,'.werodex');privateDirectory(base,false);
 const destination=path.join(base,'plan');if(fs.existsSync(destination))privateDirectory(destination,false);
 const moves=new Map<string,string>();
 for(const input of files){
  const from=path.resolve(root,input),name=path.basename(from);
  if(path.dirname(from)!==base||!name.toLowerCase().endsWith('.md')||reserved.has(name)||/^(?:logs?[-_.]|conflicts?[-_.])/i.test(name)||/(?:^|[-_.])entry(?:[-_.]|$)/i.test(name))throw new WdxError('WDX_PLAN','Only explicitly named root-level plan Markdown can be moved: '+input);
  textFile(from);const to=path.join(destination,name);
  if(fs.existsSync(to)||fs.lstatSync(path.dirname(from)).isSymbolicLink())throw new WdxError('WDX_PLAN','Plan destination already exists or is unsafe: '+to);
  moves.set(from,to);
 }
 const candidates:string[]=[];
 function walk(dir:string){for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(item.isSymbolicLink())continue;const file=path.join(dir,item.name);if(item.isFile()&&item.name.toLowerCase().endsWith('.md'))candidates.push(file);else if(item.isDirectory()&&!['assets','artifacts','conflicts'].includes(item.name))walk(file);}}
 walk(base);
 const changes=candidates.map(from=>{const old=textFile(from),to=moves.get(from)??from;return {from,to,...old,next:rewriteLinks(old.content,from,to,moves)};}).filter(x=>x.from!==x.to||x.content!==x.next);
 const report={dryRun,moves:[...moves].map(([from,to])=>({from,to})),linksUpdated:changes.filter(x=>x.content!==x.next).map(x=>x.to)};
 if(dryRun)return report;
 planDirectory(root);const staged=new Map<string,string>(),applied:typeof changes=[];
 try{
  for(const x of changes){const tmp=x.to+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,x.next,{flag:'wx',mode:x.mode});staged.set(x.to,tmp);}
  // Reject changes since preparation, before making any move.
  for(const x of changes)if(textFile(x.from).content!==x.content||(x.from!==x.to&&fs.existsSync(x.to)))throw new WdxError('WDX_CONCURRENT_CHANGE','Plan changed during migration: '+x.from);
  for(const x of changes){if(x.from===x.to)fs.renameSync(staged.get(x.to)!,x.to);else{fs.linkSync(staged.get(x.to)!,x.to);applied.push(x);fs.unlinkSync(x.from);continue;}applied.push(x);}
 }catch(e){
  for(const x of applied.reverse()){fs.writeFileSync(x.from,x.content,{mode:x.mode});if(x.from!==x.to)fs.unlinkSync(x.to);}
  throw e;
 }finally{for(const tmp of staged.values())fs.rmSync(tmp,{force:true});}
 return report;
}
