import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {Config,protectedNames,WdxError,run,shQuote} from './core';
export type PathClass='PROTECTED'|'IGNORED'|'LARGE'|'ARTIFACT'|'SOURCE';
export type Decision={kind:PathClass;reason:string};
const fixedExclude=['.werodex','.git','node_modules','.env','.env.local','.ssh','.aws','.gnupg','.npmrc','.pypirc','.netrc','id_rsa','id_ecdsa','id_ed25519'];
export const sourceExtensions=['.py','.pyi','.c','.h','.cc','.cpp','.cxx','.hpp','.hxx','.html','.css','.js','.jsx','.mjs','.cjs','.ts','.tsx','.go','.rs','.java','.sh','.bash','.md','.mdx','.yaml','.yml','.toml','.xml','.sql'];
export function isSourceExtension(relative:string){return sourceExtensions.some(ext=>relative.toLowerCase().endsWith(ext));}
function norm(relative:string){const p=relative.replaceAll('\\','/').replace(/^\.\//,''); if(!p||p.startsWith('/')||p.split('/').includes('..')||p.includes('\0'))throw new WdxError('WDX_PATH','Unsafe relative path');return p;}
export class PathPolicyEngine {
 skippedLarge:{path:string;size:number}[]=[];
 constructor(public root:string,public config:Config){}
 async classify(relative:string,size=0,artifact=false):Promise<Decision>{const p=norm(relative),parts=p.split('/');
   if(parts.some(x=>protectedNames.includes(x)))return {kind:artifact?'ARTIFACT':'PROTECTED',reason:'remote-only path'};
   if(parts.some(x=>(fixedExclude.includes(x)||x.startsWith('.env.'))) || (this.config.sync.exclude??[]).some(x=>p===x||p.startsWith(x.replace(/\/$/,'')+'/')))return {kind:'IGNORED',reason:'Werodex exclude'};
   const g=await run('git',['check-ignore','--no-index','-q','--',p],{cwd:this.root}); if(g.code===0)return {kind:'IGNORED',reason:'.gitignore'};if(g.code!==1)throw new WdxError('WDX_GITIGNORE',g.stderr||'Git ignore check failed');
   if(size>this.config.sync.maxSourceFileMB*1024*1024&&!isSourceExtension(p))return {kind:'LARGE',reason:'source size limit'};
   return {kind:artifact?'ARTIFACT':'SOURCE',reason:'source'};
 }
 async sourceFiles():Promise<Map<string,{size:number;hash:string}>>{this.skippedLarge=[];const out=new Map<string,{size:number;hash:string}>();
   const walk=async(dir:string)=>{for(const e of fs.readdirSync(path.join(this.root,dir),{withFileTypes:true})){const rel=path.posix.join(dir,e.name),full=path.join(this.root,rel); if(e.isSymbolicLink())continue; const stat=fs.statSync(full); const d=await this.classify(rel,e.isDirectory()?0:stat.size); if(d.kind==='LARGE')this.skippedLarge.push({path:rel,size:stat.size});if(d.kind!=='SOURCE')continue; if(e.isDirectory())await walk(rel); else if(e.isFile()){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(full))hash.update(chunk);out.set(rel,{size:stat.size,hash:hash.digest('hex')});}}}; await walk('');return out;
 }
 async assertTransferAllowed(files:string[]){
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
for p in ${files.map(shQuote).join(' ')}; do
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
 static remoteScanScript(){const prune=[...protectedNames,...fixedExclude,'.env.*'];const names=prune.map(n=>'-name '+shQuote(n)).join(' -o ');const sourcePattern=sourceExtensions.map(x=>'*'+x).join('|');return `set -eo pipefail\nproject="\${1%/}"\ntest "$(realpath -e -- "$project")" = "$project" || { echo unsafe-remote-project >&2; exit 2; }\ncd "$project"\nmax="$2"\nshift 2\nextra=()\nfor ex in "$@"; do extra+=( -o -path "./$ex" ); done\nfind . -type d \\( ${names} "\${extra[@]}" \\) -prune -o -type f -print0 | while IFS= read -r -d '' f; do\n p="\${f#./}"\n skip=0; for ex in "$@"; do if [[ "$p" == "$ex" || "$p" == "$ex/"* ]]; then skip=1; break; fi; done; (( skip == 0 )) || continue\n case "/$p/" in ${prune.map(n=>'*/'+n+'/*').join('|')}) continue;; esac\n if git check-ignore --no-index -q -- "$p" 2>/dev/null; then continue; else rc=$?; (( rc == 1 )) || { echo git-ignore-check-failed >&2; exit "$rc"; }; fi\n n=$(stat -c%s -- "$p")\n case "\${p,,}" in ${sourcePattern}) code_source=1;; *) code_source=0;; esac\n if (( n > max && code_source == 0 )); then b=$(printf %s "$p" | base64 -w0); printf 'L %s %s\\n' "$b" "$n"; continue; fi\n h=$(sha256sum -- "$p"); h="\${h%% *}"\n b=$(printf %s "$p" | base64 -w0)\n printf '%s %s %s\\n' "$b" "$n" "$h"\ndone`;}
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
