const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {fixture,pause}=require('./ssh-fixture.cjs'),{sync}=require('../dist/sync'),{checkpoint}=require('../dist/checkpoint'),{restoreBackup,listBackups}=require('../dist/transfer'),core=require('../dist/core'),ssh=require('../dist/ssh'),daemon=require('../dist/daemon');
const entry=root=>fs.readFileSync(path.join(root,'a.py'),'utf8');
const git=(f,root,...args)=>f.exec('git',args,{cwd:root}).trim();
test('hash-selected sync/pull ignore equal timestamps, archive old versions locally and guard restore',async()=>{
 const f=await fixture();try{
  for(const root of [f.local,f.remote]){fs.writeFileSync(root+'/a.py','AAAA');fs.utimesSync(root+'/a.py',1700000000,1700000000);}await sync(f.c,f.local,'sync');
  fs.writeFileSync(f.local+'/a.py','BBBB');fs.utimesSync(f.local+'/a.py',1700000000,1700000000);const saved=await sync(f.c,f.local,'sync');assert.equal(entry(f.remote),'BBBB');
  const id=saved.backupIds[0],backup=path.join(f.local,'.werodex/backup',id,'remote/a.py');assert.equal(fs.readFileSync(backup,'utf8'),'AAAA');assert.equal(fs.statSync(backup).mode&0o777,0o600);assert.ok(!git(f,f.remote,'status','--porcelain','--','.werodex'));
  fs.writeFileSync(f.remote+'/a.py','later user edit');await assert.rejects(()=>restoreBackup(f.c,f.local,id,'remote',['a.py']),{code:'WDX_CONCURRENT_CHANGE'});assert.equal(entry(f.remote),'later user edit');
  fs.writeFileSync(f.remote+'/a.py','BBBB');await restoreBackup(f.c,f.local,id,'remote',['a.py']);assert.equal(entry(f.remote),'AAAA');
  fs.utimesSync(f.local+'/a.py',1700000000,1700000000);fs.utimesSync(f.remote+'/a.py',1700000000,1700000000);const pulled=await sync(f.c,f.local,'pull');assert.equal(entry(f.local),'AAAA');assert.equal(fs.readFileSync(path.join(f.local,'.werodex/backup',pulled.backupIds[0],'local/a.py'),'utf8'),'BBBB');
 }finally{await f.cleanup();}
});
test('concurrent selected sync serializes Manifest updates, including different CLI processes',async()=>{
 const f=await fixture();try{
  fs.writeFileSync(f.local+'/a.py','A');fs.writeFileSync(f.local+'/b.py','B');
  const cli=p=>core.run(process.execPath,[path.resolve(__dirname,'../dist/cli.js'),'sync','--',p],{cwd:f.local,timeout:20000});
  const results=await Promise.all([cli('a.py'),cli('b.py')]);for(const result of results)assert.equal(result.code,0,result.stderr);
  const manifest=JSON.parse(fs.readFileSync(f.local+'/.werodex/state.json'));assert.equal(manifest.version,2);assert.deepEqual(Object.keys(manifest.files).sort(),['a.py','b.py']);
 }finally{await f.cleanup();}
});
test('post-scan destination changes become conflicts without advancing Manifest',async()=>{
 const f=await fixture(),original=core.run;try{
  for(const root of [f.local,f.remote])fs.writeFileSync(root+'/a.py','initial');await sync(f.c,f.local,'sync');fs.writeFileSync(f.local+'/a.py','incoming local');
  let injected=false;core.run=async(file,args,options)=>{const result=await original(file,args,options);if(file==='rsync'&&args.includes('--files-from=-')&&!injected){injected=true;fs.writeFileSync(f.remote+'/a.py','concurrent remote');}return result;};
  await assert.rejects(()=>sync(f.c,f.local,'sync'),{code:'WDX_CONFLICT'});assert.equal(entry(f.remote),'concurrent remote');assert.equal(JSON.parse(fs.readFileSync(f.local+'/.werodex/state.json')).version,1);assert.equal(listBackups(f.local).at(-1).state,'conflict');
 }finally{core.run=original;await f.cleanup();}
});
test('archive disconnect leaves remote recovery; explicit restore archives it without replaying publication',async()=>{
 const f=await fixture(),original=core.run;try{
  for(const root of [f.local,f.remote])fs.writeFileSync(root+'/a.py','old');await sync(f.c,f.local,'sync');fs.writeFileSync(f.local+'/a.py','new content');
  core.run=async(file,args,options)=>file==='rsync'&&args.some(x=>x.includes('/old/a.py'))?{code:12,stdout:'',stderr:'simulated archive disconnect'}:original(file,args,options);
  await assert.rejects(()=>sync(f.c,f.local,'sync'),{code:'WDX_BACKUP_PENDING'});assert.equal(entry(f.remote),'new content');const saved=listBackups(f.local).find(x=>x.state==='pending');assert.ok(saved);assert.equal(fs.readFileSync(path.join(f.remote,'.werodex/transfer',saved.id,'old/a.py'),'utf8'),'old');
  core.run=original;await restoreBackup(f.c,f.local,saved.id,'remote',['a.py']);assert.equal(entry(f.remote),'old');assert.equal(fs.readFileSync(path.join(f.local,'.werodex/backup',saved.id,'remote/a.py'),'utf8'),'old');
 }finally{core.run=original;await f.cleanup();}
});
test('backup quota rejects before publication and user snapshots survive storage gc',async()=>{
 const f=await fixture();try{
  for(const root of [f.local,f.remote])fs.writeFileSync(root+'/a.py','old');await sync(f.c,f.local,'sync');fs.writeFileSync(f.local+'/a.py','new');
  const tiny={...f.c,runtime:{...f.c.runtime,maxLocalStateMB:0.001}};await assert.rejects(()=>sync(tiny,f.local,'sync'),{code:'WDX_STORAGE_LIMIT'});assert.equal(entry(f.remote),'old');
  const saved=await sync(f.c,f.local,'sync');require('../dist/storage').storageGc(f.local,false);assert.equal(fs.readFileSync(path.join(f.local,'.werodex/backup',saved.backupIds[0],'remote/a.py'),'utf8'),'old');assert.ok(require('../dist/storage').storageStats(f.local).backup>0);
 }finally{await f.cleanup();}
});
test('checkpoint resume rejects soft reset but accepts later unrelated committed work',async()=>{
 const f=await fixture();try{
  for(const root of [f.local,f.remote])fs.writeFileSync(root+'/a.py','initial');await checkpoint(f.c,f.local,'initial',['a.py']);fs.writeFileSync(f.local+'/a.py','new verified source');
  const hook=f.remote+'/.git/hooks/pre-commit';fs.writeFileSync(hook,'#!/bin/sh\nexit 1\n',{mode:0o700});let id;
  await assert.rejects(()=>checkpoint(f.c,f.local,'new',['a.py']),e=>{id=e.message.match(/Checkpoint ([a-f0-9-]{36})/)[1];return e.code==='WDX_CHECKPOINT_PARTIAL';});const committed=git(f,f.local,'rev-parse','HEAD');git(f,f.local,'reset','--soft','HEAD^');fs.unlinkSync(hook);
  await assert.rejects(()=>checkpoint(f.c,f.local,'',[],id),{code:'WDX_CHECKPOINT_PARTIAL'});assert.match(git(f,f.local,'status','--porcelain','--','a.py'),/M/);
  git(f,f.local,'reset','--soft',committed);fs.writeFileSync(f.local+'/unrelated.py','unrelated');git(f,f.local,'add','unrelated.py');git(f,f.local,'commit','-qm','later unrelated');assert.equal((await checkpoint(f.c,f.local,'',[],id)).status,'complete');
 }finally{await f.cleanup();}
});
test('both remote search modes exclude links to outside credentials/data and oversized files',async()=>{
 const f=await fixture();try{
  fs.writeFileSync(f.home+'/.env','SYNTHETIC_PRIVATE_NEEDLE');fs.symlinkSync(f.home+'/.env',f.remote+'/alias.py');fs.mkdirSync(f.remote+'/data');fs.writeFileSync(f.remote+'/data/private.txt','SYNTHETIC_PRIVATE_NEEDLE');fs.symlinkSync(f.remote+'/data/private.txt',f.remote+'/data-alias.py');
  fs.writeFileSync(f.remote+'/huge.bin','SYNTHETIC_PRIVATE_NEEDLE'.repeat(100));const c={...f.c,sync:{...f.c.sync,maxSourceFileMB:0.001}};
  for(const regex of [false,true])assert.deepEqual((await ssh.remoteAction(c,'file.search',{pattern:'SYNTHETIC_PRIVATE_NEEDLE',regex})).value.matches,[]);
 }finally{await f.cleanup();}
});
test('MCP programs and their queue do not consume control/file slots',async()=>{
 const f=await fixture();let client;try{
  fs.writeFileSync(f.remote+'/a.py','readable');await ssh.remote(f.c,':');
  const {Client}=await import('@modelcontextprotocol/client'),{StdioClientTransport}=await import('@modelcontextprotocol/client/stdio');client=new Client({name:'lanes',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve(__dirname,'../dist/cli.js'),'mcp','--workspace',f.local],env:{...process.env},stderr:'pipe'}));
  const marker=f.home+'/mcp-start';const programs=Array.from({length:3},()=>client.callTool({name:'program_exec',arguments:{argv:['bash','-c','touch "$1"; sleep 1.5','program',marker],timeout:10000}}));while(!fs.existsSync(marker))await pause(10);
  const before=Date.now(),read=await client.callTool({name:'file_read',arguments:{path:'a.py',remote:true}});assert.ok(Date.now()-before<1000);assert.match(JSON.stringify(read),/readable/);for(const result of await Promise.all(programs))assert.ok(!result.isError);
 }finally{await client?.close();await f.cleanup();}
});
test('each bridge/worker failure preserves the other active lane and physical channel cap',async()=>{
 const f=await fixture();try{
  for(const kind of ['bridge','worker'])for(const broken of [0,1]){
   await ssh.remote(f.c,':');const markers=[f.home+'/control-'+kind+broken,f.home+'/blocking-'+kind+broken],ids=[crypto.randomUUID(),crypto.randomUUID()];
   const requests=['control','blocking'].map((lane,index)=>ssh.remote(f.c,'touch "$1"; sleep .7; printf result',[markers[index]],5000,1024,{lane,requestId:ids[index]}).then(result=>({result}),error=>({error})));
   while(markers.some(x=>!fs.existsSync(x)))await pause(10);const state=await daemon.rpc({op:'status',target:'fixture',config:f.c});if(kind==='bridge')process.kill(state.controlPids[broken],'SIGTERM');else f.exec('tmux',['-L','werodex-control','kill-session','-t','wdx-control-v3-'+state.connectionId+'-'+broken],{env:{...process.env,TMUX_TMPDIR:f.tmux}});const result=await Promise.all(requests);assert.equal(result[broken].error.code,'WDX_REQUEST_UNKNOWN');assert.equal(result[1-broken].result.stdout,'result');
   const auth=f.authCount();await ssh.remote(f.c,':',[],5000,1024,{lane:broken?'blocking':'control'});const recovered=await daemon.rpc({op:'request-status',target:'fixture',config:f.c,requestId:ids[broken]});assert.equal(recovered.state,kind==='bridge'?'completed':'unknown');assert.equal(f.authCount(),auth);assert.ok((await daemon.rpc({op:'status',target:'fixture',config:f.c})).globalActiveChannels<=3);const socket=ssh.controlPath(await ssh.effective('fixture'));const physical=()=>fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\0').includes('ControlPath='+socket)&&!fs.readFileSync('/proc/'+p+'/stat','utf8').split(')')[1].trim().startsWith('Z');}catch{return false;}}).length;assert.ok(physical()<=3);
  }
 }finally{await f.cleanup();}
});
test('atomic exchange preserves a target edit occurring inside the rename window',()=>{
 const base=fs.mkdtempSync('/tmp/wdx-exchange-');try{
  const worker=path.resolve(__dirname,'../src/remote-worker.py');const script=`import importlib.util,pathlib,hashlib,json,ctypes,sys\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('w',${JSON.stringify(worker)});w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)\nroot=pathlib.Path(${JSON.stringify(base)});import subprocess;subprocess.run(['git','init','-q',str(root)],check=True)\n(root/'a.py').write_text('old');id='11111111-1111-1111-1111-111111111111'\ne=lambda s:{'size':len(s),'hash':hashlib.sha256(s.encode()).hexdigest()}\npolicy={'protectedNames':[],'fixedExclude':['.git','.werodex'],'exclude':[],'maxBytes':100000,'sourceExtensions':['.py']}\npayload={'id':id,'files':[{'path':'a.py','source':e('new'),'target':e('old')}]}\nw.transaction_action('transfer.prepare',str(root),payload,policy);(root/'.werodex/transfer'/id/'incoming/a.py').write_text('new')\noriginal=ctypes.CDLL(None,use_errno=True);fn=original.renameat2;fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nclass Rename:\n def __call__(self,*args):\n  (root/'a.py').write_text('concurrent');return fn(*args)\nclass Library:renameat2=Rename()\nw.ctypes.CDLL=lambda *a,**k:Library()\nresult=w.transaction_action('transfer.commit',str(root),payload,policy)\nassert result['conflict'];assert (root/'.werodex/transfer'/id/'old/a.py').read_text()=='concurrent';assert result['files'][0]['old']==e('concurrent')\n`;
  cp.execFileSync('python3',['-B','-c',script]);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('a crash immediately after exchange recovers the displaced inode without replay',()=>{
 const base=fs.mkdtempSync('/tmp/wdx-exchange-crash-');try{
  const worker=path.resolve(__dirname,'../src/remote-worker.py');const script=`import importlib.util,pathlib,hashlib,ctypes,sys,subprocess\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('w',${JSON.stringify(worker)});w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)\nroot=pathlib.Path(${JSON.stringify(base)});subprocess.run(['git','init','-q',str(root)],check=True);(root/'a.py').write_text('old')\nid='22222222-2222-2222-2222-222222222222';e=lambda s:{'size':len(s),'hash':hashlib.sha256(s.encode()).hexdigest()}\npolicy={'protectedNames':[],'fixedExclude':['.git','.werodex'],'exclude':[],'maxBytes':100000,'sourceExtensions':['.py']};payload={'id':id,'files':[{'path':'a.py','source':e('new'),'target':e('old')}]}\nw.transaction_action('transfer.prepare',str(root),payload,policy);(root/'.werodex/transfer'/id/'incoming/a.py').write_text('new')\noriginal=ctypes.CDLL(None,use_errno=True);fn=original.renameat2;fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nclass Rename:\n def __call__(self,*args):\n  assert fn(*args)==0;raise SystemExit('simulated crash')\nclass Library:renameat2=Rename()\nw.ctypes.CDLL=lambda *a,**k:Library()\ntry:w.transaction_action('transfer.commit',str(root),payload,policy)\nexcept SystemExit:pass\ninfo=w.transaction_action('transfer.inspect',str(root),payload,policy)['files'][0];assert info['published'] and info['old']==e('old') and info['oldFolder']=='incoming'\nassert (root/'a.py').read_text()=='new';assert (root/'.werodex/transfer'/id/'incoming/a.py').read_text()=='old'\ntry:w.transaction_action('transfer.commit',str(root),payload,policy);raise AssertionError('replayed')\nexcept ValueError as error:assert 'already attempted' in str(error)\npayload['files'][0].update(old=info['old'],oldFolder=info['oldFolder']);w.transaction_action('transfer.cleanup',str(root),payload,policy);again=w.transaction_action('transfer.inspect',str(root),payload,policy)['files'][0];assert again['old']==e('old') and again['published']\n`;
  cp.execFileSync('python3',['-B','-c',script]);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
