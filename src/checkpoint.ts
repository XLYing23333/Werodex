import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Config,run,shQuote,WdxError,atomicJson,privateDirectory} from './core';
import {localGitRoot,gitBoundaryScript,assertGitResult} from './git';
import {PathPolicyEngine} from './policy';
import {remote} from './ssh';
import {sync,remoteInventory,Entry} from './sync';

type Side={head:string|null;skipped:boolean;committedPaths:string[];before:string|null};
export type CheckpointRecord={version:1;id:string;workspaceId:string;root:string;remoteProject:string;remoteTarget:string;message:string;paths:string[];expected:Record<string,Entry|null>;local:Side|null;remote:Side|null;status:'prepared'|'partial'|'complete';error?:string};
function stateDirectory(root:string){return privateDirectory(path.join(privateDirectory(path.join(root,'.werodex')),'checkpoints'));}
function validatePaths(paths:string[]){if(!paths.length)throw new WdxError('WDX_USAGE','checkpoint -m MESSAGE -- PATH...');for(const p of paths)if(!p||p.startsWith('/')||p.startsWith('./')||p.split('/').some(x=>!x||x==='.'||x==='..')||/[\\\r\n\0]/.test(p)||PathPolicyEngine.isNeverSource(p))throw new WdxError('WDX_GIT','Checkpoint path is not allowed Source: '+p);}
function expectedCheck(expected:CheckpointRecord['expected']){
 return Object.entries(expected).map(([p,e])=>e?`[[ -f ${shQuote(p)} && ! -L ${shQuote(p)} && "$(sha256sum -- ${shQuote(p)} | cut -d ' ' -f 1)" = ${shQuote(e.hash)} ]] || { echo 'WDX_CHECKPOINT_STALE: Source content changed' >&2; exit 22; }`:`[[ ! -e ${shQuote(p)} && ! -L ${shQuote(p)} ]] || { echo 'WDX_CHECKPOINT_STALE: Deleted Source reappeared' >&2; exit 22; }`).join('\n')+'\n';
}
function commitScript(record:CheckpointRecord,marker:string){
 const names=record.paths.map(shQuote).join(' ');
 return `set -e
${gitBoundaryScript()}cd "$1"
export GIT_LITERAL_PATHSPECS=1
${expectedCheck(record.expected)}
marker=${shQuote(marker)}
if [[ -f "$marker" && ! -L "$marker" ]]; then cat "$marker"; exit 0; fi
before=$(git rev-parse --verify HEAD 2>/dev/null || true)
if [[ -n "$before" ]] && git log -1 --format=%B | grep -Fxq -- ${shQuote('Werodex-Checkpoint: '+record.id)}; then
 parent=$(git rev-parse HEAD^ 2>/dev/null || true)
 actual=$(git diff-tree --root --no-commit-id --name-only -r -z HEAD -- ${names} | base64 -w0)
 printf 'COMMIT %s %s %s\\n' "$before" "\${parent:--}" "$actual"; exit 0
fi
changed=$(git status --porcelain --untracked-files=all -- ${names})
if [[ -z "$changed" ]]; then printf 'SKIP %s - -\\n' "\${before:--}"; exit 0; fi
mkdir -p -- "$(dirname -- "$marker")"
git var GIT_AUTHOR_IDENT >/dev/null
git var GIT_COMMITTER_IDENT >/dev/null
git add -N -- ${names}
git commit --only -m "$2" -m ${shQuote('Werodex-Checkpoint: '+record.id)} -- ${names} >/dev/null
head=$(git rev-parse HEAD)
actual=$(git diff-tree --root --no-commit-id --name-only -r -z HEAD -- ${names} | base64 -w0)
printf 'COMMIT %s %s %s\\n' "$head" "\${before:--}" "\${actual:--}" > "$marker.tmp"
mv -- "$marker.tmp" "$marker"
cat "$marker"
${expectedCheck(record.expected)}
`;
}
function parseSide(stdout:string,paths:string[]):Side{
 const fields=stdout.trim().split(' ');if(!['COMMIT','SKIP'].includes(fields[0])||!/^([a-f0-9]{40,64}|-)$/.test(fields[1]??''))throw new WdxError('WDX_GIT','Invalid checkpoint result');
 const actual=fields[3]&&fields[3]!=='-'?Buffer.from(fields[3],'base64').toString().split('\0').filter(Boolean):[];
 if(actual.some(p=>!paths.includes(p)))throw new WdxError('WDX_GIT','Checkpoint committed an unexpected path');
 return {head:fields[1]==='-'?null:fields[1],before:fields[2]==='-'?null:fields[2],skipped:fields[0]==='SKIP',committedPaths:actual};
}
export async function checkpoint(c:Config,root:string,message:string,paths:string[],resume?:string){
 await localGitRoot(root);
 let record:CheckpointRecord;const directory=stateDirectory(root);
 if(resume){
  if(!/^[a-f0-9-]{36}$/.test(resume))throw new WdxError('WDX_CHECKPOINT','Invalid checkpoint ID');
  try{const file=path.join(directory,resume+'.json');if(!fs.lstatSync(file).isFile())throw Error();record=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new WdxError('WDX_CHECKPOINT','Checkpoint record missing or invalid');}
  if(record.version!==1||record.id!==resume||record.workspaceId!==c.workspaceId||record.root!==fs.realpathSync(root)||record.remoteProject!==c.remote.project||record.remoteTarget!==c.remote.target||!record.expected||!Array.isArray(record.paths)||!record.paths.every(p=>Object.hasOwn(record.expected,p)))throw new WdxError('WDX_CHECKPOINT','Invalid checkpoint record');validatePaths(record.paths);
 }else{
  validatePaths(paths);if(!message?.trim())throw new WdxError('WDX_USAGE','checkpoint requires -m MESSAGE');
  // Identity checks on both sides precede sync or either commit.
  for(const identity of ['GIT_AUTHOR_IDENT','GIT_COMMITTER_IDENT'])assertGitResult(await run('git',['var',identity],{cwd:root}));
  assertGitResult(await remote(c,'set -e\n'+gitBoundaryScript()+'git -C "$1" var GIT_AUTHOR_IDENT >/dev/null\ngit -C "$1" var GIT_COMMITTER_IDENT >/dev/null\n',[c.remote.project]));
  await sync(c,root,'sync');
  const local=await new PathPolicyEngine(root,c).sourceFiles(),rem=await remoteInventory(c),expected:CheckpointRecord['expected']={};
  for(const p of [...new Set(paths)]){
   const l=local.get(p)??null,r=rem.get(p)??null;
   if(JSON.stringify(l)!==JSON.stringify(r))throw new WdxError('WDX_CHECKPOINT_STALE','Source must match on both sides (deletions require explicit reconciliation): '+p);
   if(!l){const decision=await new PathPolicyEngine(root,c).classify(p);if(decision.kind!=='SOURCE')throw new WdxError('WDX_GIT','Checkpoint path is not allowed Source: '+p);}
   expected[p]=l;
  }
  record={version:1,id:randomUUID(),workspaceId:c.workspaceId,root:fs.realpathSync(root),remoteProject:c.remote.project,remoteTarget:c.remote.target,message,paths:Object.keys(expected),expected,local:null,remote:null,status:'prepared'};
 }
 const file=path.join(directory,record.id+'.json'),lock=file+'.lock';let fd:number;
 try{fd=fs.openSync(lock,'wx',0o600);}catch{throw new WdxError('WDX_CHECKPOINT_BUSY','Checkpoint is already being processed');}
 try{
  // Check convergence again even on resume, before creating any new commit.
  const local=await new PathPolicyEngine(root,c).sourceFiles(),rem=await remoteInventory(c);
  for(const p of record.paths)for(const now of [local.get(p)??null,rem.get(p)??null])if(JSON.stringify(now)!==JSON.stringify(record.expected[p]))throw new WdxError('WDX_CHECKPOINT_STALE','Source changed since checkpoint preparation: '+p);
  atomicJson(file,record);
  if(!record.local){const r=await run('bash',['-s','--',root,record.message],{input:commitScript(record,path.join(directory,record.id+'.local')),timeout:120000});if(r.stdout.trim())record.local=parseSide(r.stdout,record.paths);assertGitResult(r,'WDX_CHECKPOINT');record.status='partial';atomicJson(file,record);}
  if(!record.remote){
   const marker=`$HOME/.local/state/werodex/checkpoints/${c.workspaceId}/${record.id}.remote`;
   // Expand only the fixed HOME prefix; all user text remains quoted.
   const script=commitScript(record,marker).replace('marker='+shQuote(marker),'marker="$HOME/.local/state/werodex/checkpoints/'+c.workspaceId+'/'+record.id+'.remote"');
   const r=await remote(c,script,[c.remote.project,record.message],120000);if(r.stdout.trim())record.remote=parseSide(r.stdout,record.paths);assertGitResult(r,'WDX_CHECKPOINT');atomicJson(file,record);
  }
  if(!record.local||!record.remote)throw new WdxError('WDX_CHECKPOINT','Missing endpoint commit result');
  const finalLocal=await new PathPolicyEngine(root,c).sourceFiles(),finalRemote=await remoteInventory(c);
  for(const p of record.paths)for(const current of [finalLocal.get(p)??null,finalRemote.get(p)??null])if(JSON.stringify(current)!==JSON.stringify(record.expected[p]))throw new WdxError('WDX_CHECKPOINT_STALE','Source changed during checkpoint: '+p);
  record.status='complete';delete record.error;atomicJson(file,record);
  fs.writeFileSync(path.join(root,'.werodex/checkpoint'),(record.remote.head??'')+'\n',{mode:0o600});atomicJson(path.join(root,'.werodex/checkpoint-state.json'),record);
  return record;
 }catch(e){record.error=(e as Error).message;atomicJson(file,record);throw new WdxError('WDX_CHECKPOINT_PARTIAL',`Checkpoint ${record.id}: ${record.error}. Local=${record.local?.head??'not recorded'}; remote=${record.remote?.head??'not recorded'}. Resume with werodex checkpoint --resume ${record.id}`);}
 finally{fs.closeSync(fd);fs.rmSync(lock,{force:true});}
}
