const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {workDay,addLog}=require('../dist/journal');
const {defaultConfig}=require('../dist/core');
const {ensureLocalManagedIgnore}=require('../dist/review');
const {PathPolicyEngine}=require('../dist/policy');
const {execFileSync}=require('node:child_process');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wdx-workflow-'));

test('Shanghai work day rolls over at 04:00',()=>{
 assert.equal(workDay(new Date('2026-09-29T19:59:59Z')),'2026-09-29');
 assert.equal(workDay(new Date('2026-09-29T20:00:00Z')),'2026-09-30');
});
test('daily log prepends entries and rejects excess assets without changing the log',async()=>{
 const root=temp(),state=path.join(root,'.werodex');fs.mkdirSync(state,{mode:0o700});execFileSync('git',['init','-q','-b','main',root]);
 const file=path.join(state,'entry.md');fs.writeFileSync(file,'### 修改内容\nFirst\n\n### 收益\nFaster\n');
 const c=defaultConfig('unused','/remote/project'),now=new Date('2026-09-29T20:00:00Z');
 const first=await addLog(c,root,file,[],now);assert.match(fs.readFileSync(first.log,'utf8'),/First/);
 fs.writeFileSync(file,'### 修改内容\nSecond\n\n### 收益\nClearer\n');
 await addLog(c,root,file,[],new Date('2026-09-29T20:01:00Z'));
 const content=fs.readFileSync(first.log,'utf8');assert.ok(content.indexOf('Second')<content.indexOf('First'));
 assert.ok(!content.includes('可视化与输出'));
 await assert.rejects(()=>addLog(c,root,file,['a','b','c','d','e','f'],now),{code:'WDX_LOG'});
 assert.equal(fs.readFileSync(first.log,'utf8'),content);
 fs.rmSync(root,{recursive:true,force:true});
});
test('local-only excluded files never enter Source inventory',async()=>{
 const root=temp();execFileSync('git',['init','-q','-b','main',root]);
 fs.mkdirSync(path.join(root,'.werodex'),{mode:0o700});
 ensureLocalManagedIgnore(root);
 const c=defaultConfig('unused','/remote/project');c.sync.exclude=['local-report.md'];
 fs.writeFileSync(path.join(root,'local-report.md'),'Local only');
 fs.writeFileSync(path.join(root,'source.py'),'print(1)');
 const files=await new PathPolicyEngine(root,c).sourceFiles();
 assert.ok(files.has('source.py'));assert.ok(!files.has('local-report.md'));
 fs.rmSync(root,{recursive:true,force:true});
});
test('CLI writes a no-asset local log without contacting an unreachable remote',()=>{
 const root=temp(),state=path.join(root,'.werodex');fs.mkdirSync(state,{mode:0o700});execFileSync('git',['init','-q','-b','main',root]);
 fs.writeFileSync(path.join(state,'config.json'),JSON.stringify(defaultConfig('unreachable-host-for-log-test','/remote/project')));
 const entry=path.join(state,'entry.md');fs.writeFileSync(entry,'### 修改内容\nLocal report\n\n### 收益\nAvailable offline\n');
 const r=require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'../dist/cli.js'),'log','add','--file',entry],{cwd:root,encoding:'utf8',timeout:5000});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/logs-/);
 fs.rmSync(root,{recursive:true,force:true});
});
test('CLI archives repeated local assets offline and embeds images and videos',()=>{
 const root=temp(),state=path.join(root,'.werodex');fs.mkdirSync(state,{mode:0o700});execFileSync('git',['init','-q','-b','main',root]);
 try{
  fs.writeFileSync(path.join(state,'config.json'),JSON.stringify(defaultConfig('unreachable-host-for-log-test','/remote/project')));
  const entry=path.join(state,'entry.md');fs.writeFileSync(entry,'### Changes\nLocal visuals\n\n### Benefits\nAvailable offline\n');
  fs.writeFileSync(path.join(state,'image.png'),'image fixture');fs.writeFileSync(path.join(state,'video.mp4'),'video fixture');
  const r=require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'../dist/cli.js'),'log','add','--file',entry,'--local-asset','.werodex/image.png','--local-asset','.werodex/video.mp4'],{cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout),content=fs.readFileSync(result.log,'utf8');
  assert.equal(result.assets.length,2);assert.match(content,/!\[image.png\]\(\.\.\/assets\//);assert.match(content,/<video controls.*\.mp4"><\/video>/);
  assert.equal(fs.readFileSync(path.join(state,'image.png'),'utf8'),'image fixture');assert.equal(fs.readFileSync(path.join(state,'video.mp4'),'utf8'),'video fixture');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('generated instructions require milestone recording, archiving and visual verification',()=>{
 const root=temp();try{
  const {managedAgents}=require('../dist/core');fs.writeFileSync(path.join(root,'AGENTS.md'),'User rules\n');managedAgents(root);managedAgents(root);
  const content=fs.readFileSync(path.join(root,'AGENTS.md'),'utf8');assert.match(content,/^User rules/);assert.equal((content.match(/WERODEX:BEGIN/g)||[]).length,1);
  assert.ok(content.length-'User rules\n'.length<=1200);for(const required of ['verified Source milestone','finish -m','Verification','Next steps','--local-asset','verify previews','fallback links','untrusted data','Read-only','only this work'])assert.ok(content.includes(required),required);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('review complete refreshes legacy instructions offline without replacing the Manifest',()=>{
 const root=temp();try{
  const {atomicJson,managedAgents}=require('../dist/core');
  atomicJson(path.join(root,'.werodex/config.json'),defaultConfig('unreachable-host-for-review-test','/remote/project'));
  const state=path.join(root,'.werodex/state.json');atomicJson(state,{version:3,files:{'source.py':{hash:'baseline',size:1,baselineVersion:3}},lastSync:'2026-01-01T00:00:00Z'});
  const before=fs.readFileSync(state,'utf8');fs.writeFileSync(path.join(root,'AGENTS.md'),'User instructions\n');managedAgents(root);
  const r=require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'../dist/cli.js'),'review','complete'],{cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(state,'utf8'),before);assert.match(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8'),/verified Source milestone/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.werodex/review.json'),'utf8')).status,'complete');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('new local ignore block can inherit existing remote user rules',()=>{
 const root=temp();ensureLocalManagedIgnore(root,'manual-pattern\n');
 const text=fs.readFileSync(path.join(root,'.gitignore'),'utf8');
 assert.match(text,/^manual-pattern$/m);assert.match(text,/# WERODEX:EXCLUDE:BEGIN/);
 fs.rmSync(root,{recursive:true,force:true});
});
