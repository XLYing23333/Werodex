const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fixture}=require('./ssh-fixture.cjs');
const {checkpoint}=require('../dist/checkpoint');
const {checkMilestone,localDirtySource}=require('../dist/milestone');
const {addLog}=require('../dist/journal');
const git=(f,root,...args)=>f.exec('git',args,{cwd:root}).trim();
function entry(root){const file=path.join(root,'.werodex','logs','entry.md');fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,'### Changes\nMilestone\n\n### Benefits\nRecoverable\n');return file;}

test('dual checkpoint commits named Source, preserves unrelated staged work and skips no-ops',async()=>{
 const f=await fixture();try{
  for(const root of [f.local,f.remote]){fs.writeFileSync(path.join(root,'a.py'),'first');fs.writeFileSync(path.join(root,'other.py'),'unrelated');git(f,root,'add','--','other.py');}
  const result=await checkpoint(f.c,f.local,'verified stage',['a.py']);assert.equal(result.status,'complete');assert.ok(result.local.head);assert.ok(result.remote.head);assert.deepEqual(result.local.committedPaths,['a.py']);assert.deepEqual(result.remote.committedPaths,['a.py']);
  for(const root of [f.local,f.remote]){assert.equal(git(f,root,'show','HEAD:a.py'),'first');assert.match(git(f,root,'diff','--cached','--name-only'),/other.py/);assert.equal(git(f,root,'ls-tree','--name-only','HEAD'),'a.py');}
  const skipped=await checkpoint(f.c,f.local,'no changes',['a.py']);assert.equal(skipped.local.skipped,true);assert.equal(skipped.remote.skipped,true);assert.equal(skipped.local.head,result.local.head);
  await assert.rejects(()=>addLog(f.c,f.local,entry(f.local),[]),{code:'WDX_CHECKPOINT_REQUIRED'});
  await checkpoint(f.c,f.local,'finish related work',['other.py']);const log=await addLog(f.c,f.local,entry(f.local),[]);assert.equal(log.verification.remote,'verified');
 }finally{await f.cleanup();}
});
test('partial dual commit can resume without repeating the successful local commit',async()=>{
 const f=await fixture();try{
  fs.writeFileSync(path.join(f.local,'a.py'),'source');const hook=path.join(f.remote,'.git/hooks/pre-commit');fs.writeFileSync(hook,'#!/bin/sh\nexit 1\n',{mode:0o700});
  let id;await assert.rejects(()=>checkpoint(f.c,f.local,'verified',['a.py']),e=>{assert.equal(e.code,'WDX_CHECKPOINT_PARTIAL');id=e.message.match(/Checkpoint ([a-f0-9-]{36})/)[1];return true;});
  const localHead=git(f,f.local,'rev-parse','HEAD');fs.unlinkSync(hook);
  const result=await checkpoint(f.c,f.local,'',[],id);assert.equal(result.local.head,localHead);assert.equal(git(f,f.local,'rev-list','--count','HEAD'),'1');assert.equal(git(f,f.remote,'rev-list','--count','HEAD'),'1');assert.equal(result.status,'complete');
  fs.writeFileSync(path.join(f.local,'a.py'),'new changes');await assert.rejects(()=>checkpoint(f.c,f.local,'',[],id),{code:'WDX_CHECKPOINT_PARTIAL'});
 }finally{await f.cleanup();}
});
test('identity failure precedes sync or commit and rule files cannot be checkpointed',async()=>{
 const f=await fixture();try{
  fs.writeFileSync(path.join(f.local,'a.py'),'source');git(f,f.local,'config','user.name','');git(f,f.local,'config','user.useConfigOnly','true');
  await assert.rejects(()=>checkpoint(f.c,f.local,'verified',['a.py']),{code:'WDX_GIT'});assert.ok(!fs.existsSync(path.join(f.remote,'a.py')));
  for(const name of ['AGENTS.md','.gitignore','nested/.dockerignore'])await assert.rejects(()=>checkpoint(f.c,f.local,'rules',[name]),{code:'WDX_GIT'});
 }finally{await f.cleanup();}
});
test('log gate sees staged edits, deletions and rename sources but ignores remote data and rules',async()=>{
 const f=await fixture();try{
  for(const root of [f.local,f.remote]){fs.writeFileSync(path.join(root,'a.py'),'a');fs.writeFileSync(path.join(root,'remove.py'),'b');}
  await checkpoint(f.c,f.local,'baseline',['a.py','remove.py']);
  git(f,f.local,'mv','a.py','renamed.py');fs.unlinkSync(path.join(f.local,'remove.py'));fs.writeFileSync(path.join(f.local,'AGENTS.md'),'local rules');fs.mkdirSync(path.join(f.local,'outputs'));fs.writeFileSync(path.join(f.local,'outputs','result.py'),'artifact');
  assert.deepEqual((await localDirtySource(f.c,f.local)).sort(),['a.py','remove.py','renamed.py']);
  await assert.rejects(()=>checkMilestone(f.c,f.local),{code:'WDX_CHECKPOINT_REQUIRED'});assert.ok(!fs.existsSync(path.join(f.local,'.werodex/assets')));
  git(f,f.local,'reset','--hard','HEAD');fs.writeFileSync(path.join(f.remote,'a.py'),'remote pending');await assert.rejects(()=>checkMilestone(f.c,f.local),{code:'WDX_CHECKPOINT_REQUIRED'});
 }finally{await f.cleanup();}
});
test('a hook changing working Source after commit yields a recoverable partial result',async()=>{
 const f=await fixture();try{
  fs.writeFileSync(path.join(f.local,'a.py'),'verified source');const hook=path.join(f.local,'.git/hooks/pre-commit');fs.writeFileSync(hook,'#!/bin/sh\nprintf mutated > a.py\n',{mode:0o700});
  let id;await assert.rejects(()=>checkpoint(f.c,f.local,'verified',['a.py']),e=>{assert.equal(e.code,'WDX_CHECKPOINT_PARTIAL');id=e.message.match(/Checkpoint ([a-f0-9-]{36})/)[1];return true;});
  const saved=JSON.parse(fs.readFileSync(path.join(f.local,'.werodex/checkpoints',id+'.json'),'utf8'));assert.ok(saved.local.head);assert.equal(saved.remote,null);assert.equal(git(f,f.local,'rev-list','--count','HEAD'),'1');
  fs.unlinkSync(hook);fs.writeFileSync(path.join(f.local,'a.py'),'verified source');const complete=await checkpoint(f.c,f.local,'',[],id);assert.equal(complete.local.head,saved.local.head);assert.equal(git(f,f.local,'rev-list','--count','HEAD'),'1');assert.equal(complete.status,'complete');
 }finally{await f.cleanup();}
});
