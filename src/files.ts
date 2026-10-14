import {withWorkspaceLock} from './lock';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Config,readBoundedFile,privateDirectory,WdxError,run,protectedNames} from './core';
import {PathPolicyEngine} from './policy';
import {remoteAction} from './ssh';
import {checkStorageBudget,stateUsage,invalidateUsage} from './storage';
import {truncateUtf8} from './output';
export type FileOptions={path?:string;remote?:boolean;preview?:boolean;startLine?:number;endLine?:number;maxBytes?:number;limit?:number;pattern?:string;regex?:boolean;content?:string;expectedHash?:string;edits?:Array<{oldText:string;newText:string}>;localOnly?:boolean};
const sha=(content:Buffer|string)=>createHash('sha256').update(content).digest('hex');
function resolve(root:string,input:string,missing=false){if(!input||path.isAbsolute(input)||input.split('/').some(p=>p==='..'||p==='')||input.includes('\0'))throw new WdxError('WDX_PATH','Use a literal workspace-relative path');PathPolicyEngine.assertNotCredential(input);const file=path.resolve(root,input);if(fs.realpathSync(root)!==path.resolve(root))throw new WdxError('WDX_PATH','Symlink workspace');let directory=path.dirname(file);while(file!==root&&directory!==root){if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw new WdxError('WDX_PATH','Unsafe file parent');directory=path.dirname(directory);}if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw new WdxError('WDX_PATH','Symlink file');if(!missing&&!fs.existsSync(file))throw new WdxError('WDX_PATH','File missing');return file;}
function editMarker(root:string,name:string){return path.join(privateDirectory(path.join(privateDirectory(path.join(root,'.werodex')),'edits')),sha(name)+'.json');}
export async function verifyEditScope(root:string,names:string[]){for(const name of names){try{const marker=JSON.parse(fs.readFileSync(editMarker(root,name),'utf8'));if(marker.initialDirty)throw new WdxError('WDX_SCOPE_CONFLICT','Pre-existing user changes in '+name+'; select/merge the intended commit scope explicitly');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}}}
export async function fileOperation(c:Config,root:string,operation:string,options:FileOptions){
 if(['write','patch'].includes(operation))return withWorkspaceLock(root,()=>fileOperationLocked(c,root,operation,options));return fileOperationLocked(c,root,operation,options);
}
async function fileOperationLocked(c:Config,root:string,operation:string,options:FileOptions){
 if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1))throw new WdxError('WDX_USAGE','Invalid result limit');
 const name=options.path??'.',limit=Math.min(262144,Math.max(1,options.maxBytes??65536));if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(options.startLine??1)||(options.startLine??1)<1)throw new WdxError('WDX_USAGE','Invalid range');
 if(options.remote){if(['write','patch'].includes(operation))throw new WdxError('WDX_PATH','Source edits are local');return (await remoteAction(c,'file.'+operation,options)).value;}
 const file=resolve(root,name,operation==='write');const policy=new PathPolicyEngine(root,c);
 if(operation==='list'){
  if(!fs.lstatSync(file).isDirectory())throw new WdxError('WDX_PATH','Directory required');const entries:any[]=[];const max=Math.min(200,Math.max(1,options.limit??40));const iterator=fs.opendirSync(file);
  try{for(let item=iterator.readSync();item;item=iterator.readSync()){if(item.isSymbolicLink())continue;const relative=path.relative(root,path.join(file,item.name)).replaceAll(path.sep,'/');try{PathPolicyEngine.assertNotCredential(relative);}catch{continue;}if((await policy.classify(relative)).kind!=='SOURCE')continue;entries.push({name:item.name,type:item.isDirectory()?'directory':'file'});if(entries.length>=max)break;}}finally{iterator.closeSync();}
  return {path:name,entries,limited:entries.length>=max,untrusted:true};
 }
 if(operation==='read'){
  const stat=fs.lstatSync(file);if(!stat.isFile())throw new WdxError('WDX_PATH','Regular file required');if(PathPolicyEngine.protectedData(name,c)&&!options.preview)return {path:name,size:stat.size,protected:true,untrusted:true};
  const start=options.startLine??1,end=options.endLine??start+200;if(!Number.isSafeInteger(end)||end<start)throw new WdxError('WDX_USAGE','Invalid end line');
  const stream=fs.createReadStream(file,{highWaterMark:32768});let pending='',line=1,content='',truncated=false,scanned=0;const decoder=new (require('node:string_decoder').StringDecoder)('utf8');
  outer:for await(const chunk of stream){scanned+=chunk.length;if(scanned>8*1024*1024){truncated=true;break;}pending+=decoder.write(chunk);for(;;){const at=pending.indexOf('\n');if(at<0){if(Buffer.byteLength(pending)>limit){if(line>=start)content+=truncateUtf8(pending,limit-Buffer.byteLength(content));truncated=true;break outer;}break;}const text=pending.slice(0,at+1);pending=pending.slice(at+1);if(line>=start){content+=truncateUtf8(text,Math.max(0,limit-Buffer.byteLength(content)));if(Buffer.byteLength(content)>=limit){truncated=true;break outer;}}if(line++>=end){truncated=true;break outer;}}}
  stream.destroy();if(!truncated&&line>=start)content+=truncateUtf8(pending+decoder.end(),Math.max(0,limit-Buffer.byteLength(content)));
  let hash:string|null=null;if(stat.size<=4*1024*1024)hash=sha(readBoundedFile(file,4*1024*1024));return {path:name,content,startLine:start,endLine:line,size:stat.size,hash,truncated,untrusted:true};
 }
 if(operation==='search'){
  if(typeof options.pattern!=='string'||!options.pattern||options.pattern.length>1024)throw new WdxError('WDX_USAGE','Search pattern required');const source=await policy.sourceFiles({hash:false});const names=[...source.keys()].filter(p=>name==='.'||p===name||p.startsWith(name.replace(/\/$/,'')+'/'));const matches:any[]=[];let bytes=128;if(!names.length)return {matches,truncated:false,untrusted:true};
  if(options.regex){const result=await run('rg',['--json','--max-count','100','-e',options.pattern,'--',...names],{cwd:root,timeout:10000,maxBytes:1024*1024});if(result.code>1)throw new WdxError('WDX_SEARCH',result.stderr);for(const line of result.stdout.split('\n')){if(!line)continue;const record=JSON.parse(line);if(record.type==='match'){const item={path:record.data.path.text,line:record.data.line_number,text:truncateUtf8(record.data.lines.text,200)},size=Buffer.byteLength(JSON.stringify(item))+1;if(bytes+size>limit)return {matches,truncated:true,untrusted:true};bytes+=size;matches.push(item);};if(matches.length>=Math.min(200,options.limit??100))break;}return {matches,truncated:result.code===125||matches.length>=Math.min(200,options.limit??100),untrusted:true};}
  for(const relative of names){const target=resolve(root,relative);const stream=fs.createReadStream(target,{highWaterMark:32768});let pending='',number=0;const decoder=new (require('node:string_decoder').StringDecoder)('utf8');
   for await(const chunk of stream){pending+=decoder.write(chunk);const lines=pending.split('\n');pending=lines.pop()!;if(Buffer.byteLength(pending)>262144)pending='';for(const line of lines){number++;if(line.includes(options.pattern)){const text=truncateUtf8(line,200);const item={path:relative,line:number,text},size=Buffer.byteLength(JSON.stringify(item))+1;if(bytes+size>limit){stream.destroy();return {matches,truncated:true,untrusted:true};}bytes+=size;matches.push(item);if(matches.length>=Math.min(200,options.limit??100)){stream.destroy();return {matches:matches.slice(0,200),truncated:true,untrusted:true};}}}}
   if(pending.includes(options.pattern)){const item={path:relative,line:number+1,text:truncateUtf8(pending,200)},size=Buffer.byteLength(JSON.stringify(item))+1;if(bytes+size>limit)return {matches,truncated:true,untrusted:true};bytes+=size;matches.push(item);}if(matches.length>=Math.min(200,options.limit??100))return {matches,truncated:true,untrusted:true};
  }
  return {matches,truncated:false,untrusted:true};
 }
 if(!['write','patch'].includes(operation))throw new WdxError('WDX_USAGE','Unknown file operation');
 const metadata=/^\.werodex\/(?:plan|logs|entries)\/.+\.md$/.test(name),localOnly=options.localOnly&&(c.sync.exclude??[]).some(p=>name===p||name.startsWith(p+'/'));
 if(!metadata&&!localOnly&&PathPolicyEngine.isNeverSource(name))throw new WdxError('WDX_PATH','Protected or rule file cannot be edited as Source');
 if(fs.existsSync(file)&&fs.statSync(file).size>4*1024*1024)throw new WdxError('WDX_LARGE_FILE','Use streamed import for files over 4 MiB');const old=fs.existsSync(file)?readBoundedFile(file,4*1024*1024):undefined;if(old&&old.length>4*1024*1024)throw new WdxError('WDX_LARGE_FILE','Use streamed import for files over 4 MiB');
 if(old&&!Buffer.from(old.toString('utf8')).equals(old))throw new WdxError('WDX_BINARY_FILE','Native edits require UTF-8 text');
 if(old&&(!options.expectedHash||sha(old)!==options.expectedHash))throw new WdxError('WDX_CONCURRENT_CHANGE','Read the file and provide its current hash before editing');
 let next:string;
 if(operation==='write'){if(typeof options.content!=='string')throw new WdxError('WDX_USAGE','Content required');next=options.content;}else{if(!old||!Array.isArray(options.edits)||!options.edits.length||options.edits.length>100||options.edits.some(edit=>typeof edit.oldText!=='string'||typeof edit.newText!=='string'))throw new WdxError('WDX_USAGE','Patch edits required');next=old.toString();for(const edit of options.edits){if(!edit.oldText||next.indexOf(edit.oldText)<0||next.indexOf(edit.oldText)!==next.lastIndexOf(edit.oldText))throw new WdxError('WDX_PATCH_CONFLICT','Each oldText must match exactly once');next=next.replace(edit.oldText,edit.newText);}}
 if(Buffer.byteLength(next)>4*1024*1024)throw new WdxError('WDX_LARGE_FILE','Edit payload exceeds 4 MiB');
 if(!metadata&&!localOnly){if((await policy.classify(name,Buffer.byteLength(next))).kind!=='SOURCE')throw new WdxError('WDX_PATH','Not eligible Source');const marker=editMarker(root,name);if(!fs.existsSync(marker)){const status=await run('git',['status','--porcelain','--',name],{cwd:root});fs.writeFileSync(marker,JSON.stringify({path:name,initialDirty:!!old&&!!status.stdout.trim(),beforeHash:old?sha(old):null}),{flag:'wx',mode:0o600});}}
 if(name.startsWith('.werodex/logs/')){checkStorageBudget(c,stateUsage(root).total+Buffer.byteLength(next)-(old?.length??0));invalidateUsage(root);}
 resolve(root,name,true);if(!metadata&&!localOnly)PathPolicyEngine.assertSafeTransferPath(root,name);
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:metadata?0o700:0o755});const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,next,{flag:'wx',mode:old?(fs.statSync(file).mode&0o777):0o644});if(old&&sha(readBoundedFile(file,4*1024*1024))!==options.expectedHash)throw new WdxError('WDX_CONCURRENT_CHANGE','File changed while preparing edit');resolve(root,name,true);if(!old&&fs.existsSync(file))throw new WdxError('WDX_CONCURRENT_CHANGE','New file appeared while preparing edit');fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
 return {path:name,hash:sha(next),bytes:Buffer.byteLength(next),changedPaths:metadata||localOnly?[]:[name],untrusted:true};
}
