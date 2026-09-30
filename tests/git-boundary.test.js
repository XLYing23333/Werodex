const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const {localGitRoot,gitBoundaryScript}=require('../dist/git');
const {defaultConfig,atomicJson}=require('../dist/core');
const {PathPolicyEngine}=require('../dist/policy');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wdx-boundary-'));
const git=(dir,...args)=>cp.execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['pipe','pipe','pipe']});
function guard(dir,allowMissing=false){return cp.spawnSync('bash',['-s','--',dir],{input:'set -e\n'+gitBoundaryScript(allowMissing),encoding:'utf8'});}
function cli(dir,args,remoteEnabled=false){
 const dist=path.resolve(__dirname,'../dist');
 const hook=`const core=require(${JSON.stringify(dist+'/core')});const daemon=require(${JSON.stringify(dist+'/daemon')});const ssh=require(${JSON.stringify(dist+'/ssh')});
 const run=core.run;core.run=async(file,args,options)=>{
  if(file==='ssh'){if(args[0]==='-G')return {code:0,stdout:'hostname fixture\\nuser fixture\\nport 22\\n',stderr:''};if(!args.includes('fixture')||!args.at(-1).startsWith('bash -s -- '))throw Error('Unexpected SSH');return run('bash',['-c',args.at(-1)],options);}
  if(file==='rsync'){const local=args.map(a=>a.replace(/^fixture:/,''));if(!local.slice(-2).every(p=>p.startsWith(${JSON.stringify(path.dirname(dir)+path.sep)})))throw Error('Unsafe fixture rsync');return run(file,local,options);}return run(file,args,options);
 };
 daemon.ensureDaemon=async()=>{if(!${remoteEnabled})throw Error('UNEXPECTED CONNECTION');};daemon.rpc=async()=>({});daemon.withLease=async(c,f)=>f();
 ssh.remote=async(c,script,args=[],timeout)=>{if(script.startsWith('for c in git rsync'))return {code:0,stdout:'',stderr:''};return core.run('bash',['-s','--',...args],{input:script,timeout});};
 process.argv=[process.execPath,${JSON.stringify(dist+'/cli.js')},...${JSON.stringify(args)}];require(${JSON.stringify(dist+'/cli.js')});`;
 return cp.spawnSync(process.execPath,['-e',hook],{cwd:dir,encoding:'utf8',timeout:10000,env:{...process.env,WERODEX_STATE_DIR:path.join(path.dirname(dir),'transport')}});
}
test('both guards reject a parent repository and permit an explicit child repository',async()=>{
 const base=temp(),child=path.join(base,'child');
 try{
  git(base,'init','-q','-b','main');fs.mkdirSync(child);fs.writeFileSync(path.join(child,'source.py'),'pass');
  const parentExclude=fs.readFileSync(path.join(base,'.git/info/exclude'),'utf8');
  await assert.rejects(()=>localGitRoot(child,true),{code:'WDX_GIT_PARENT'});
  await assert.rejects(()=>new PathPolicyEngine(child,defaultConfig('fixture',child)).sourceFiles(),{code:'WDX_GIT_PARENT'});
  for(const allowMissing of [false,true]){const r=guard(child,allowMissing);assert.equal(r.status,21);assert.match(r.stderr,/WDX_GIT_PARENT/);}
  assert.equal(fs.readFileSync(path.join(base,'.git/info/exclude'),'utf8'),parentExclude);assert.ok(!fs.existsSync(path.join(child,'.git')));
  git(child,'init','-q','-b','main');assert.equal(await localGitRoot(child),child);assert.equal(guard(child).status,0);
  assert.deepEqual([...await new PathPolicyEngine(child,defaultConfig('fixture',child)).sourceFiles()].map(([p])=>p),['source.py']);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('missing repositories are accepted only by initialization checks',async()=>{
 const dir=temp();try{assert.equal(await localGitRoot(dir,true),undefined);await assert.rejects(()=>localGitRoot(dir),{code:'WDX_GIT'});assert.equal(guard(dir,true).status,0);assert.equal(guard(dir).status,20);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('local and remote guards accept linked worktrees',async()=>{
 const base=temp(),repo=path.join(base,'repo'),worktree=path.join(base,'worktree');
 try{
  fs.mkdirSync(repo);git(repo,'init','-q','-b','main');git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','initial');
  git(repo,'worktree','add','-qb','fixture',worktree);assert.ok(fs.statSync(path.join(worktree,'.git')).isFile());
  assert.equal(await localGitRoot(worktree),worktree);assert.equal(guard(worktree).status,0);
  fs.writeFileSync(path.join(worktree,'source.py'),'pass');assert.ok((await new PathPolicyEngine(worktree,defaultConfig('fixture',worktree)).sourceFiles()).has('source.py'));
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('CLI rejects a local parent before connecting or changing either side',()=>{
 const base=temp(),local=path.join(base,'local'),remote=path.join(base,'remote');
 try{
  git(base,'init','-q','-b','main');fs.mkdirSync(local);fs.mkdirSync(remote);fs.writeFileSync(path.join(remote,'AGENTS.md'),'remote rules');
  const exclude=fs.readFileSync(path.join(base,'.git/info/exclude'),'utf8');
  const r=cli(local,['init','--target','fixture','--project',remote]);assert.equal(r.status,1);assert.match(r.stderr,/WDX_GIT_PARENT/);assert.doesNotMatch(r.stderr,/UNEXPECTED CONNECTION/);
  assert.ok(!fs.existsSync(path.join(local,'.werodex')));assert.ok(!fs.existsSync(path.join(remote,'.gitignore')));assert.equal(fs.readFileSync(path.join(remote,'AGENTS.md'),'utf8'),'remote rules');
  atomicJson(path.join(local,'.werodex/config.json'),defaultConfig('fixture',remote));atomicJson(path.join(local,'.werodex/review.json'),{status:'complete'});
  for(const command of ['sync','pull','rebuild','diff','status','checkpoint','git-tree','conflict']){const r=cli(local,[command]);assert.equal(r.status,1,command);assert.match(r.stderr,/WDX_GIT_PARENT/,command);assert.doesNotMatch(r.stderr,/UNEXPECTED CONNECTION/);}
  assert.equal(fs.readFileSync(path.join(base,'.git/info/exclude'),'utf8'),exclude);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('init rejects a remote parent before creating local Git or managed files',()=>{
 const base=temp(),local=path.join(base,'local'),parent=path.join(base,'remote-parent'),remote=path.join(parent,'project');
 try{
  fs.mkdirSync(local);fs.mkdirSync(parent);git(parent,'init','-q','-b','main');fs.mkdirSync(remote);fs.writeFileSync(path.join(remote,'AGENTS.md'),'remote rules');
  const exclude=fs.readFileSync(path.join(parent,'.git/info/exclude'),'utf8');
  const r=cli(local,['init','--target','fixture','--project',remote],true);assert.equal(r.status,1);assert.match(r.stderr,/WDX_GIT_PARENT/);
  assert.deepEqual(fs.readdirSync(local),[]);assert.deepEqual(fs.readdirSync(remote),['AGENTS.md']);assert.equal(fs.readFileSync(path.join(parent,'.git/info/exclude'),'utf8'),exclude);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('init creates main repositories while preserving separate existing rules',()=>{
 const base=temp(),local=path.join(base,'local'),remote=path.join(base,'remote');
 try{
  for(const dir of [local,remote])fs.mkdirSync(dir);
  fs.writeFileSync(path.join(local,'AGENTS.md'),'local instructions\n');fs.writeFileSync(path.join(remote,'AGENTS.md'),'remote instructions\n');
  fs.writeFileSync(path.join(local,'.gitignore'),'local-only\n',{mode:0o600});fs.writeFileSync(path.join(remote,'.gitignore'),'remote-only\n',{mode:0o640});
  const r=cli(local,['init','--target','fixture','--project',remote],true);assert.equal(r.status,0,r.stderr);
  for(const dir of [local,remote])assert.equal(git(dir,'symbolic-ref','--short','HEAD').trim(),'main');
  assert.equal(fs.readFileSync(path.join(remote,'AGENTS.md'),'utf8'),'remote instructions\n');
  for(const [dir,rule,other,mode] of [[local,'local-only','remote-only',0o600],[remote,'remote-only','local-only',0o640]]){
   const content=fs.readFileSync(path.join(dir,'.gitignore'),'utf8');assert.match(content,new RegExp('^'+rule+'\\n'));assert.ok(!content.includes(other));assert.equal(fs.statSync(path.join(dir,'.gitignore')).mode&0o777,mode);
  }
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('CLI rebuild transfers Source while checkpoint rejects rule files before sync',()=>{
 const base=temp(),local=path.join(base,'local'),remote=path.join(base,'remote');
 try{
  const {ensureLocalManagedIgnore}=require('../dist/review');
  for(const dir of [local,remote]){fs.mkdirSync(dir);git(dir,'init','-q','-b','main');ensureLocalManagedIgnore(dir);fs.writeFileSync(path.join(dir,'AGENTS.md'),dir===local?'local':'remote');}
  atomicJson(path.join(local,'.werodex/config.json'),defaultConfig('fixture',remote));atomicJson(path.join(local,'.werodex/review.json'),{status:'complete'});
  fs.writeFileSync(path.join(remote,'source.py'),'remote source');
  const rebuild=cli(local,['rebuild'],true);assert.equal(rebuild.status,0,rebuild.stderr);assert.equal(fs.readFileSync(path.join(local,'source.py'),'utf8'),'remote source');
  assert.equal(fs.readFileSync(path.join(local,'AGENTS.md'),'utf8'),'local');assert.equal(fs.readFileSync(path.join(remote,'AGENTS.md'),'utf8'),'remote');
  fs.writeFileSync(path.join(local,'source.py'),'unsynced source');const state=fs.readFileSync(path.join(local,'.werodex/state.json'),'utf8');
  for(const name of ['AGENTS.md','.gitignore','.ignore','.dockerignore','.rgignore','nested/AGENTS.md']){
   const r=cli(local,['checkpoint','-m','rules','--',name],true);assert.equal(r.status,1);assert.match(r.stderr,/Checkpoint path is not allowed Source/);
  }
  assert.equal(fs.readFileSync(path.join(remote,'source.py'),'utf8'),'remote source');assert.equal(fs.readFileSync(path.join(local,'.werodex/state.json'),'utf8'),state);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
