const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const core=require('../dist/core');
const ssh=require('../dist/ssh');
const daemon=require('../dist/daemon');
const {PathPolicyEngine}=require('../dist/policy');
const {ensureLocalManagedIgnore}=require('../dist/review');
const realRun=core.run;
let transfers=0;
core.run=async(file,args,opts)=>{if(file==='ssh'){
 if(args[0]==='-G')return {code:0,stdout:'hostname test\nuser test\nport 22\n',stderr:''};
 assert.ok(args.includes('test')&&args.at(-1).startsWith('bash -s -- '));return realRun('bash',['-c',args.at(-1)],opts);
 }if(file==='rsync'){transfers++;throw Error('Unexpected rsync before policy approval');}return realRun(file,args,opts);};
daemon.withLease=async(c,fn)=>fn();
// Execute the production remote scripts in an isolated second local repository.
ssh.remote=async(c,script,args=[],timeout=60000,maxBytes)=>realRun('bash',['-s','--',...args],{input:script,timeout,maxBytes});
const {sync}=require('../dist/sync');
function setup(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'wdx-transfer-'));
 const local=path.join(base,'local'),remote=path.join(base,'remote');process.env.WERODEX_STATE_DIR=path.join(base,'transport');
 for(const dir of [local,remote]){fs.mkdirSync(dir);cp.execFileSync('git',['init','-q','-b','main',dir]);ensureLocalManagedIgnore(dir);}
 const c=core.defaultConfig('test',remote);
 core.atomicJson(path.join(local,'.werodex','review.json'),{status:'complete'});
 return {base,local,remote,c};
}
for(const direction of ['sync','pull'])for(const scenario of ['ignored-existing','ignored-missing','large-existing','tracked-ignored']){
 test(`${direction} blocks ${scenario} before any transfer`,async()=>{
  const {base,local,remote,c}=setup();const source=direction==='sync'?local:remote,target=direction==='sync'?remote:local;
  try{
   const p='private.txt';fs.writeFileSync(path.join(source,p),'new');fs.writeFileSync(path.join(source,'safe.py'),'print(1)');
   if(scenario!=='ignored-missing')fs.writeFileSync(path.join(target,p),'existing target content');
   if(scenario==='tracked-ignored')cp.execFileSync('git',['add','--',p],{cwd:target});
   if(scenario==='large-existing')c.sync.maxSourceFileMB=10/1024/1024;
   else fs.appendFileSync(path.join(target,'.gitignore'),'\nprivate.txt\n');
   const before=transfers;
   await assert.rejects(()=>sync(c,local,direction),{code:'WDX_TRANSFER_POLICY'});
   assert.equal(transfers,before);assert.ok(!fs.existsSync(path.join(target,'safe.py')));
   if(scenario!=='ignored-missing')assert.equal(fs.readFileSync(path.join(target,p),'utf8'),'existing target content');
   else assert.ok(!fs.existsSync(path.join(target,p)));
  }finally{fs.rmSync(base,{recursive:true,force:true});}
 });
}
test('both policies permit ordinary new Source and protect common credential files',async()=>{
 const {base,local,c}=setup();try{
  const policy=new PathPolicyEngine(local,c);await policy.assertTransferAllowed(['new.py']);
  const accepted=await ssh.remote(c,PathPolicyEngine.remoteTransferCheckScript(['new.py'],c),[c.remote.project]);assert.equal(accepted.code,0,accepted.stderr);
  for(const p of ['.env.production','.npmrc','.pypirc','.netrc','id_ed25519','.aws/credentials']){
   fs.mkdirSync(path.dirname(path.join(local,p)),{recursive:true});fs.writeFileSync(path.join(local,p),'synthetic secret');
   assert.equal((await policy.classify(p)).kind,'IGNORED');
  }
  fs.writeFileSync(path.join(local,'data'),'protected file');
  fs.writeFileSync(path.join(local,'node_modules'),'excluded file');
  assert.equal((await policy.classify('data')).kind,'PROTECTED');
  const localFiles=await policy.sourceFiles();const scan=await ssh.remote(c,PathPolicyEngine.remoteScanScript(),[local,'33554432']);assert.equal(scan.code,0,scan.stderr);
  const remoteFiles=scan.stdout.trim().split('\n').filter(Boolean).map(x=>Buffer.from(x.split(' ')[0],'base64').toString());
  assert.deepEqual([...localFiles.keys()],[]);assert.deepEqual(remoteFiles,[]);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
