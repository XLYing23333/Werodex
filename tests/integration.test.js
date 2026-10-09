const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const core=require('../dist/core'),ssh=require('../dist/ssh'),daemon=require('../dist/daemon');
const realRun=core.run;let fixtureBase,transferred=[];
// Production shell scripts and real rsync, restricted to two disposable directories.
daemon.withLease=async(c,f)=>f();
daemon.withTransferLease=async(c,f)=>f('/tmp/werodex-fixture.sock');daemon.ensureDaemon=async()=>{};daemon.existingConnection=async()=>null;
daemon.rpc=async q=>{if(q.op==='action')return require('./native-fixture.cjs')(q.request);if(q.op==='exec'){const r=q.request;return realRun('bash',['-s','--',...r.args],{input:r.script,timeout:r.timeout,maxBytes:r.maxBytes});}return {};};
ssh.remote=async(c,script,args=[],timeout=60000,maxBytes)=>realRun('bash',['-s','--',...args],{input:script,timeout,maxBytes});
ssh.effective=async()=>({});ssh.controlPath=()=>'/tmp/werodex-unused-fixture.sock';
core.run=async(file,args,options)=>{
 if(file==='ssh'){
  if(args[0]==='-G')return {code:0,stdout:'hostname fixture\nuser fixture\nport 22\n',stderr:''};
  assert.ok(args.includes('fixture')&&args.at(-1).startsWith('bash -s -- '));
  return realRun('bash',['-c',args.at(-1)],options);
 }
 if(file!=='rsync')return realRun(file,args,options);
 const localArgs=args.map(a=>a.replace(/^fixture:/,'')),endpoints=localArgs.slice(-2);
 assert.ok(endpoints.every(p=>p.startsWith(fixtureBase+path.sep)),JSON.stringify(endpoints));
 transferred.push(...(options?.input??'').split('\0').filter(Boolean));
 return realRun(file,localArgs,options);
};
const {sync,diff,restoreConflict}=require('../dist/sync');
const {gitTree,addLog}=require('../dist/journal');
const {PathPolicyEngine,ruleFileNames}=require('../dist/policy');
const {ensureLocalManagedIgnore,updateExcludeBoth,initReview}=require('../dist/review');
function setup(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'wdx-integration-')),local=path.join(base,'local'),remote=path.join(base,'remote');fixtureBase=base;transferred=[];process.env.WERODEX_STATE_DIR=path.join(base,'transport');
 for(const dir of [local,remote]){fs.mkdirSync(dir);cp.execFileSync('git',['init','-q','-b','main',dir]);ensureLocalManagedIgnore(dir);}
 const c=core.defaultConfig('fixture',remote);core.atomicJson(path.join(local,'.werodex/config.json'),c);core.atomicJson(path.join(local,'.werodex/review.json'),{status:'complete'});
 return {base,local,remote,c};
}
for(const direction of ['sync','pull'])test(`${direction} preserves rule files at every depth across first and subsequent transfers`,async()=>{
 const {base,local,remote,c}=setup();try{
  const snapshot=new Map();
  for(const [side,dir] of [['local',local],['remote',remote]])for(const prefix of ['', 'nested/'])for(const name of ruleFileNames){
   const file=path.join(dir,prefix+name);fs.mkdirSync(path.dirname(file),{recursive:true});
   if(prefix===''&&name==='.gitignore')fs.appendFileSync(file,side+'-ignored\n');else fs.writeFileSync(file,side+' original '+name+'\n');
   snapshot.set(file,fs.readFileSync(file,'utf8'));
  }
  const source=direction==='sync'?local:remote;fs.writeFileSync(path.join(source,'source.py'),'first');
  const result=await sync(c,local,direction);assert.equal(result.transferred,1);assert.deepEqual(transferred,['source.py']);
  // Seed legacy rule-file baselines, including converged root and nested entries.
  const state=path.join(local,'.werodex/state.json'),manifest=JSON.parse(fs.readFileSync(state));
  for(const name of ruleFileNames)for(const prefix of ['', 'nested/'])manifest.files[prefix+name]={size:1,hash:'old',baselineVersion:1};core.atomicJson(state,manifest);
  fs.writeFileSync(path.join(source,'source.py'),'second');await sync(c,local,direction);
  assert.deepEqual(await diff(c,local),[]);assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(state)).files),['source.py']);
  for(const [file,content] of snapshot)assert.equal(fs.readFileSync(file,'utf8'),content,file);
  assert.equal(fs.readFileSync(path.join(local,'source.py'),'utf8'),'second');assert.equal(fs.readFileSync(path.join(remote,'source.py'),'utf8'),'second');
  const policy=new PathPolicyEngine(local,c);
  for(const name of ruleFileNames)for(const prefix of ['', 'nested/']){
   await assert.rejects(()=>policy.assertTransferAllowed([prefix+name]),{code:'WDX_TRANSFER_POLICY'});
   assert.throws(()=>PathPolicyEngine.remoteTransferCheckScript([prefix+name],c),{code:'WDX_TRANSFER_POLICY'});
  }
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('legacy rule-file conflicts cannot resolve, keep, or restore either side',async()=>{
 const {base,local,remote,c}=setup();try{
  const id=crypto.randomUUID();fs.writeFileSync(path.join(local,'AGENTS.md'),'local');fs.writeFileSync(path.join(remote,'AGENTS.md'),'remote');
  core.atomicJson(path.join(local,'.werodex/conflicts',id,'report.json'),{id,conflicts:[{path:'AGENTS.md'}]});
  for(const strategy of ['resolve','keepLocal','keepRemote'])await assert.rejects(()=>sync(c,local,'sync',{[strategy]:id}),{code:'WDX_CONFLICT'});
  for(const side of ['local','remote'])await assert.rejects(()=>restoreConflict(c,local,id,side),{code:'WDX_CONFLICT'});
  assert.deepEqual(transferred,[]);assert.equal(fs.readFileSync(path.join(local,'AGENTS.md'),'utf8'),'local');assert.equal(fs.readFileSync(path.join(remote,'AGENTS.md'),'utf8'),'remote');
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('existing workspaces reject a remote parent in scan, sync, diff, state, git-tree and restore',async()=>{
 const {base,local,remote,c}=setup();try{
  fs.rmSync(path.join(remote,'.git'),{recursive:true});cp.execFileSync('git',['init','-q','-b','main',base]);
  fs.writeFileSync(path.join(local,'source.py'),'source');
  const id=crypto.randomUUID();core.atomicJson(path.join(local,'.werodex/conflicts',id,'report.json'),{id,conflicts:[{path:'source.py'}]});
  for(const operation of [()=>sync(c,local,'sync'),()=>sync(c,local,'pull'),()=>diff(c,local),()=>ssh.gitState(c,local),()=>gitTree(c,local),()=>restoreConflict(c,local,id,'remote')])await assert.rejects(operation,{code:'WDX_GIT_PARENT'});
  const check=await ssh.remote(c,PathPolicyEngine.remoteTransferCheckScript(['source.py'],c),[remote]);assert.equal(check.code,21);
  assert.deepEqual(transferred,[]);assert.ok(!fs.existsSync(path.join(remote,'source.py')));assert.ok(!fs.existsSync(path.join(local,'.werodex/git-tree.md')));
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('exclude changes preserve separate ignore rules and permissions on both sides',async()=>{
 const {base,local,remote,c}=setup();try{
  fs.rmSync(path.join(local,'.werodex/review.json'));initReview(local);
  for(const [dir,rule,mode] of [[local,'local-private',0o600],[remote,'remote-private',0o640]]){fs.appendFileSync(path.join(dir,'.gitignore'),rule+'\n');fs.chmodSync(path.join(dir,'.gitignore'),mode);fs.writeFileSync(path.join(dir,rule),'private');}
  await updateExcludeBoth(local,c,'add','downloads','dataset');await updateExcludeBoth(local,core.readConfig(local),'remove','downloads');
  for(const [dir,rule,mode] of [[local,'local-private',0o600],[remote,'remote-private',0o640]]){
   const content=fs.readFileSync(path.join(dir,'.gitignore'),'utf8');assert.match(content,new RegExp(rule));assert.ok(!content.includes('/downloads'));assert.equal(fs.statSync(path.join(dir,'.gitignore')).mode&0o777,mode);
   assert.ok(!(await new PathPolicyEngine(dir,core.readConfig(local)).sourceFiles()).has(rule));
  }
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
function entry(local){const file=path.join(local,'.werodex/entry.md');fs.writeFileSync(file,'### Changes\nMilestone\n\n### Benefits\nEvidence\n\n### Verification\nPassed\n\n### Next steps\nNone\n');return file;}
const now=new Date('2026-09-29T20:00:00Z');
test('real remote fetch and local copy produce mixed media embeds and escaped relative links',async()=>{
 const {base,local,remote,c}=setup();try{
  fs.mkdirSync(path.join(remote,'outputs'));const remoteImage=path.join(remote,'outputs','plot [a](b)#.svg'),localVideo=path.join(local,'.werodex','clip "a".webm'),localOther=path.join(local,'.werodex','<report>.txt');
  fs.writeFileSync(remoteImage,'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>');fs.writeFileSync(localVideo,'video fixture');fs.writeFileSync(localOther,'text');
  const result=await addLog(c,local,entry(local),[remoteImage],now,{localAssets:[path.relative(local,localVideo),localOther]});const content=fs.readFileSync(result.log,'utf8');
  assert.equal(result.assets.length,3);assert.match(content,/!\[plot \\\[a\\\]/);assert.match(content,/<video controls preload="metadata" src="\.\.\/assets\/2026-09-30\//);assert.match(content,/%5Ba%5D%28b%29%23.svg/);assert.match(content,/&lt;report&gt;/);assert.match(content,/%22a%22.webm/);
  for(const asset of result.assets){assert.ok(asset.path.startsWith(path.join(local,'.werodex/assets/2026-09-30/')));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(asset.path)).digest('hex'),asset.hash);assert.ok(content.includes(asset.hash));}
  for(const match of content.matchAll(/\]\((\.\.\/assets\/[^)]+)\)|src="([^"]+)"/g)){const relative=decodeURIComponent(match[1]??match[2]);assert.ok(fs.existsSync(path.resolve(path.dirname(result.log),relative)));}
  assert.equal(fs.readFileSync(localVideo,'utf8'),'video fixture');assert.equal(fs.readFileSync(localOther,'utf8'),'text');
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('same-name local and remote assets remain distinct and all attachments roll back on failure',async()=>{
 const {base,local,remote,c}=setup();try{
  fs.mkdirSync(path.join(remote,'outputs'));const remoteImage=path.join(remote,'outputs/preview.png'),localImage=path.join(local,'.werodex','preview.png');fs.writeFileSync(remoteImage,'remote');fs.writeFileSync(localImage,'local');
  const file=entry(local),result=await addLog(c,local,file,[remoteImage],now,{localAssets:[localImage]});assert.notEqual(result.assets[0].path,result.assets[1].path);
  const old=fs.readFileSync(result.log,'utf8'),dir=path.dirname(result.assets[0].path),before=fs.readdirSync(dir);
  await assert.rejects(()=>addLog(c,local,file,[remoteImage],now,{localAssets:[localImage,'missing.png']}),{code:'ENOENT'});
  assert.equal(fs.readFileSync(result.log,'utf8'),old);assert.deepEqual(fs.readdirSync(dir),before);assert.ok(!fs.existsSync(result.log+'.lock'));
  await assert.rejects(()=>addLog(c,local,file,[remoteImage],now,{localAssets:Array(5).fill(localImage)}),{code:'WDX_LOG'});
  const huge=path.join(local,'.werodex','huge.mp4');const fd=fs.openSync(huge,'w');fs.ftruncateSync(fd,32*1024*1024+1);fs.closeSync(fd);
  await assert.rejects(()=>addLog(c,local,file,[],now,{localAssets:[localImage,huge]}),{code:'WDX_LARGE_FILE'});
  fs.symlinkSync(localImage,path.join(local,'.werodex','link.png'));await assert.rejects(()=>addLog(c,local,file,[],now,{localAssets:['.werodex/link.png']}),{code:'WDX_PATH'});
  await assert.rejects(()=>addLog(c,local,file,[],now,{localAssets:[local]}),{code:'WDX_LOG'});
  assert.equal(fs.readFileSync(result.log,'utf8'),old);assert.deepEqual(fs.readdirSync(dir),before);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
