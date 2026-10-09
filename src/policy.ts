import {invalidateUsage,checkStorageBudget,stateUsage} from './storage';
import {count} from './diagnostics';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {Config,protectedNames,WdxError,run,shQuote,privateDirectory} from './core';
import {localGitRoot,gitBoundaryScript} from './git';
export type PathClass='PROTECTED'|'IGNORED'|'LARGE'|'ARTIFACT'|'SOURCE';
export type Decision={kind:PathClass;reason:string};
export const ruleFileNames=['AGENTS.md','.gitignore','.ignore','.dockerignore','.rgignore'];
export const fixedExclude=[...ruleFileNames,'.werodex','.git','node_modules','.env','.env.local','.ssh','.aws','.gnupg','.npmrc','.pypirc','.netrc','id_rsa','id_ecdsa','id_ed25519'];
export const sourceExtensions=['.py','.pyi','.c','.h','.cc','.cpp','.cxx','.hpp','.hxx','.html','.css','.js','.jsx','.mjs','.cjs','.ts','.tsx','.go','.rs','.java','.sh','.bash','.md','.mdx','.yaml','.yml','.toml','.xml','.sql'];
export function isSourceExtension(relative:string){return sourceExtensions.some(ext=>relative.toLowerCase().endsWith(ext));}
function norm(relative:string){const p=relative.replaceAll('\\','/').replace(/^\.\//,''); if(!p||p.length>4096||p.startsWith('/')||p.split('/').includes('..')||p.includes('\0'))throw new WdxError('WDX_PATH','Unsafe relative path');return p;}
export class PathPolicyEngine {
 private gitCheck?:Promise<string|undefined>;
 private checkGit(){return this.gitCheck??=localGitRoot(this.root,false,'WDX_GITIGNORE');}
 skippedLarge:{path:string;size:number}[]=[];
 constructor(public root:string,public config:Config){}
 async classify(relative:string,size=0,artifact=false):Promise<Decision>{const p=norm(relative),parts=p.split('/');
   if(parts.some(x=>protectedNames.includes(x)))return {kind:artifact?'ARTIFACT':'PROTECTED',reason:'remote-only path'};
   if(parts.some(x=>(fixedExclude.includes(x)||x.startsWith('.env.'))) || (this.config.sync.exclude??[]).some(x=>p===x||p.startsWith(x.replace(/\/$/,'')+'/')))return {kind:'IGNORED',reason:'Werodex exclude'};
   await this.checkGit();
   const g=await run('git',['check-ignore','--no-index','-q','--',p],{cwd:this.root}); if(g.code===0)return {kind:'IGNORED',reason:'.gitignore'};if(g.code!==1)throw new WdxError('WDX_GITIGNORE',g.stderr||'Git ignore check failed');
   if(size>this.config.sync.maxSourceFileMB*1024*1024&&!isSourceExtension(p))return {kind:'LARGE',reason:'source size limit'};
   return {kind:artifact?'ARTIFACT':'SOURCE',reason:'source'};
 }
 static protectedData(relative:string,config:Config){return relative.split('/').some(p=>protectedNames.includes(p)||p==='node_modules')||(config.sync.exclude??[]).some(p=>relative===p||relative.startsWith(p+'/'));}
 static policyData(config:Config){return {protectedNames,fixedExclude,sourceExtensions,exclude:config.sync.exclude??[],maxBytes:Math.floor(config.sync.maxSourceFileMB*1024*1024)};}
 static assertNotCredential(relative:string){if(relative.replaceAll('\\','/').split('/').some(x=>['.git','.env','.ssh','.aws','.gnupg','.npmrc','.pypirc','.netrc','id_rsa','id_ecdsa','id_ed25519'].includes(x)||x.startsWith('.env.')))throw new WdxError('WDX_PATH','Credential path is not available as content or an attachment');}
 async sourceFiles(options:{paths?:string[];full?:boolean;hash?:boolean}={}):Promise<Map<string,{size:number;hash:string}>>{
  count('scans');this.gitCheck=undefined;await this.checkGit();this.skippedLarge=[];const deadline=Date.now()+120000;
  let names=options.paths;
  if(!names){const listed=await run('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:this.root});if(listed.code)throw new WdxError('WDX_GITIGNORE',listed.stderr);names=[...new Set(listed.stdout.split('\0').filter(Boolean))];}
  const candidates:{p:string;size:number;token:string}[]=[];
  for(const input of names){const p=norm(input);if(PathPolicyEngine.isNeverSource(p)||(this.config.sync.exclude??[]).some(x=>p===x||p.startsWith(x+'/')))continue;
   try{PathPolicyEngine.assertSafeTransferPath(this.root,p);const st=fs.statSync(path.join(this.root,p),{bigint:true});if(!st.isFile())continue;if(st.size>BigInt(Math.floor(this.config.sync.maxSourceFileMB*1024*1024))&&!isSourceExtension(p)){this.skippedLarge.push({path:p,size:Number(st.size)});continue;}candidates.push({p,size:Number(st.size),token:[st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].join(':')});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'||(e instanceof WdxError&&e.code==='WDX_PATH'))continue;throw e;}
  }
  const ignored=new Set<string>();if(candidates.length){const result=await run('git',['check-ignore','--no-index','--stdin','-z'],{cwd:this.root,input:candidates.map(x=>x.p).join('\0')+'\0'});if(result.code>1)throw new WdxError('WDX_GITIGNORE',result.stderr);for(const p of result.stdout.split('\0').filter(Boolean))ignored.add(p);}
  if(options.hash===false)return new Map(candidates.filter(item=>!ignored.has(item.p)).map(item=>[item.p,{size:item.size,hash:''}]));
  const cacheDir=privateDirectory(path.join(privateDirectory(path.join(this.root,'.werodex')),'cache'));if(!fs.lstatSync(cacheDir).isDirectory()||fs.lstatSync(cacheDir).isSymbolicLink())throw new WdxError('WDX_PATH','Unsafe index cache directory');
  const buckets=new Map<string,Record<string,{token:string;hash:string}>>(),changed=new Set<string>(),out=new Map<string,{size:number;hash:string}>();
  count('filesScanned',candidates.length);let cacheBytes=0;for(const item of candidates){if(ignored.has(item.p))continue;const key=createHash('sha256').update(item.p).digest('hex').slice(0,2);let bucket=buckets.get(key);if(!bucket){try{const file=path.join(cacheDir,key+'.json');const bytes=fs.lstatSync(file).size;if(fs.lstatSync(file).isFile()&&bytes<=1024*1024&&cacheBytes+bytes<=8*1024*1024){cacheBytes+=bytes;bucket=JSON.parse(fs.readFileSync(file,'utf8'));}}catch{}bucket=Object.assign(Object.create(null),bucket??{});buckets.set(key,bucket!);}
   let digest=bucket![item.p]?.token===item.token&&!options.full&&/^[a-f0-9]{64}$/.test(bucket![item.p].hash)?bucket![item.p].hash:undefined;
   if(digest)count('hashCacheHits');if(!digest){count('filesHashed');count('bytesHashed',item.size);const hash=createHash('sha256');let seen=0;for await(const chunk of fs.createReadStream(path.join(this.root,item.p))){seen+=chunk.length;if(seen>item.size)throw new WdxError('WDX_CONCURRENT_CHANGE','Source grew during hashing');if(Date.now()>deadline)throw new WdxError('WDX_TIMEOUT','Source hash deadline exceeded');hash.update(chunk);}const current=fs.statSync(path.join(this.root,item.p),{bigint:true});if(seen!==item.size||[current.dev,current.ino,current.size,current.mtimeNs,current.ctimeNs].join(':')!==item.token)throw new WdxError('WDX_CONCURRENT_CHANGE','Source changed during hashing');digest=hash.digest('hex');bucket![item.p]={token:item.token,hash:digest};changed.add(key);}
   out.set(item.p,{size:item.size,hash:digest});
  }
  if(changed.size)invalidateUsage(this.root);for(const key of changed){const bucket=buckets.get(key)!;const entries=Object.entries(bucket).slice(-4096);const file=path.join(cacheDir,key+'.json'),tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(Object.fromEntries(entries)),{mode:0o600});fs.renameSync(tmp,file);}
  return out;
 }
 async assertTransferAllowed(files:string[]){
  await localGitRoot(this.root);
  for(const p of files){
   PathPolicyEngine.assertSafeTransferPath(this.root,p);
   const full=path.join(this.root,p),size=fs.existsSync(full)?fs.statSync(full).size:0;
   const decision=await this.classify(p,size);
   if(decision.kind!=='SOURCE')throw new WdxError('WDX_TRANSFER_POLICY',`Transfer blocked by local ${decision.kind} policy: ${p}`);
  }
 }
 static remoteTransferCheckScript(files:string[],config:Config){
  for(const p of files)if(this.isNeverSource(p)||(config.sync.exclude??[]).some(x=>p===x||p.startsWith(x.replace(/\/$/,'')+'/')))throw new WdxError('WDX_TRANSFER_POLICY','Transfer blocked by Werodex policy: '+p);
  return `set -e
project="$1"
[[ "$(realpath -e -- "$project")" = "$project" ]] || exit 9
cd "$project"
${gitBoundaryScript()}for p in ${files.map(shQuote).join(' ')}; do
 [[ "$(realpath -m -- "$project/$p")" = "$project/$p" ]] || { echo "Unsafe transfer path: $p" >&2; exit 9; }
 [[ ! -e "$p" || -f "$p" ]] || { echo "Non-file transfer path: $p" >&2; exit 9; }
 if git check-ignore --no-index -q -- "$p"; then echo "Transfer blocked by remote ignore policy: $p" >&2; exit 9; else rc=$?; (( rc == 1 )) || exit "$rc"; fi
 if [[ -f "$p" ]]; then
  n=$(stat -c%s -- "$p")
  case "\${p,,}" in ${sourceExtensions.map(x=>'*'+x).join('|')}) ;; *) (( n <= ${Math.floor(config.sync.maxSourceFileMB*1024*1024)} )) || { echo "Transfer blocked by remote large-file policy: $p" >&2; exit 9; };; esac
 fi
done
`;
 }
 static remoteScanScript(){const prune=[...protectedNames,...fixedExclude,'.env.*'];const names=prune.map(n=>'-name '+shQuote(n)).join(' -o ');const sourcePattern=sourceExtensions.map(x=>'*'+x).join('|');return `set -eo pipefail\nproject="\${1%/}"\ntest "$(realpath -e -- "$project")" = "$project" || { echo unsafe-remote-project >&2; exit 2; }\ncd "$project"\n${gitBoundaryScript()}max="$2"\nshift 2\nextra=()\nfor ex in "$@"; do extra+=( -o -path "./$ex" ); done\nfind . -type d \\( ${names} "\${extra[@]}" \\) -prune -o -type f -print0 | while IFS= read -r -d '' f; do\n p="\${f#./}"\n skip=0; for ex in "$@"; do if [[ "$p" == "$ex" || "$p" == "$ex/"* ]]; then skip=1; break; fi; done; (( skip == 0 )) || continue\n case "/$p/" in ${prune.map(n=>'*/'+n+'/*').join('|')}) continue;; esac\n if git check-ignore --no-index -q -- "$p" 2>/dev/null; then continue; else rc=$?; (( rc == 1 )) || { echo git-ignore-check-failed >&2; exit "$rc"; }; fi\n n=$(stat -c%s -- "$p")\n case "\${p,,}" in ${sourcePattern}) code_source=1;; *) code_source=0;; esac\n if (( n > max && code_source == 0 )); then b=$(printf %s "$p" | base64 -w0); printf 'L %s %s\\n' "$b" "$n"; continue; fi\n h=$(sha256sum -- "$p"); h="\${h%% *}"\n b=$(printf %s "$p" | base64 -w0)\n printf '%s %s %s\\n' "$b" "$n" "$h"\ndone`;}
 static remoteDirtySourceScript(config:Config){
  const prune=[...protectedNames,...fixedExclude,'.env.*'];
  return `set -eo pipefail\n${gitBoundaryScript()}cd "$1"\nfilter() {\n case "/$p/" in ${prune.map(n=>'*/'+n+'/*').join('|')}) return 0;; esac\n${(config.sync.exclude??[]).map(ex=>` [[ "$p" != ${shQuote(ex)} && "$p" != ${shQuote(ex+'/')}* ]] || return 0\n`).join('')} if git check-ignore --no-index -q -- "$p"; then return 0; else rc=$?; (( rc == 1 )) || exit "$rc"; fi\n if [[ -e "$p" ]]; then [[ -f "$p" && ! -L "$p" ]] || return 0; n=$(stat -c%s -- "$p"); case "\${p,,}" in ${sourceExtensions.map(x=>'*'+x).join('|')}) ;; *) (( n <= ${Math.floor(config.sync.maxSourceFileMB*1024*1024)} )) || return 0;; esac; fi\n printf '%s\\n' "$(printf %s "$p" | base64 -w0)"\n}\ngit status --porcelain -z --untracked-files=all | while IFS= read -r -d '' record; do code="\${record:0:2}"; p="\${record:3}"; filter; if [[ "$code" == *R* || "$code" == *C* ]]; then IFS= read -r -d '' p; filter; fi; done\n`;
 }
 static isNeverSource(relative:string){return norm(relative).split('/').some(x=>protectedNames.includes(x)||(fixedExclude.includes(x)||x.startsWith('.env.')));}
 static assertSafeTransferPath(root:string,relative:string){
  const parts=norm(relative).split('/');
  if(fs.realpathSync(root)!==path.resolve(root))throw new WdxError('WDX_PATH','Transfer root is a symlink');
  let current=root;
  for(let i=0;i<parts.length;i++){
   current=path.join(current,parts[i]);let stat:fs.Stats;
   try{stat=fs.lstatSync(current);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')break;throw e;}
   if(stat.isSymbolicLink()||(i<parts.length-1&&!stat.isDirectory())||(i===parts.length-1&&!stat.isFile()))throw new WdxError('WDX_PATH','Transfer path contains a symlink or non-file: '+relative);
  }
 }
 static artifactDestination(root:string,relative:string){
  const parts=norm(relative).split('/');let dir=root;
  for(const part of ['.werodex','artifacts',...parts.slice(0,-1)]){
   dir=path.join(dir,part);
   try{if(!fs.lstatSync(dir).isDirectory())throw new WdxError('WDX_PATH','Artifact destination traverses a non-directory or symlink');}
   catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;fs.mkdirSync(dir,{mode:0o700});}
  }
  const dst=path.join(dir,parts.at(-1)!);
  try{fs.lstatSync(dst);throw new WdxError('WDX_FETCH_EXISTS','Artifact destination already exists: '+dst);}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  return dst;
 }
 static safeRemotePath(base:string,requested:string){if(!requested.startsWith('/'))throw new WdxError('WDX_PATH','Remote path must be absolute');const b=path.posix.normalize(base),r=path.posix.normalize(requested);if(r!==b&&!r.startsWith(b+'/'))throw new WdxError('WDX_PATH','Remote path outside project');return r;}
}
