const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,pause}=require('./ssh-fixture.cjs');
const {remote}=require('../dist/ssh');
const {rpc,ensureDaemon}=require('../dist/daemon');
test('persistent SSH and tmux workers execute commands without reauthentication',async()=>{
 const f=await fixture();try{
  const result=await remote(f.c,'printf "hello\\n"; printf "error\\n" >&2');assert.equal(result.code,0);assert.equal(result.stdout,'hello\n');assert.equal(result.stderr,'error\n');
  assert.equal((await remote(f.c,'printf "%s" "$1"',["a b'c"])).stdout,"a b'c");
  const state=await rpc({op:'status',target:'fixture',config:f.c});assert.equal(state.controlChannels,2);assert.equal(state.maxChannels,3);assert.equal(f.authCount(),1);
 }catch(e){e.message+='\n'+require('node:fs').readFileSync(require('node:path').join(f.base,'sshd.log'),'utf8');throw e;}finally{await f.cleanup();}
});
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const core=require('../dist/core'),ssh=require('../dist/ssh'),daemon=require('../dist/daemon');
const {sync}=require('../dist/sync'),{startJob,waitJob,logs}=require('../dist/jobs');
async function until(predicate,timeout=5000){const deadline=Date.now()+timeout;while(!await predicate()){if(Date.now()>deadline)throw Error('Fixture condition timed out');await pause(20);}}
test('100 cross-CLI calls reuse two workers, all three channels are bounded, and waits do not block status',async()=>{
 const f=await fixture();try{
  await remote(f.c,':');const initial=await rpc({op:'status',target:'fixture',config:f.c});
  for(let i=0;i<100;i++){
   const r=await core.run(process.execPath,[path.resolve(__dirname,'../dist/cli.js'),'exec','--','printf','command-'+i],{cwd:f.local,timeout:10000});assert.equal(r.code,0,r.stderr);assert.equal(r.stdout.trim(),'command-'+i);
  }
  const reused=await rpc({op:'status',target:'fixture',config:f.c});assert.deepEqual(reused.controlPids,initial.controlPids);assert.equal(reused.connectionAttempts,1);assert.equal(f.authCount(),1);
  const pending=remote(f.c,'sleep 1; printf done',[],3000,1024,{lane:'blocking'});const fast=await remote(f.c,'printf status');assert.equal(fast.stdout,'status');assert.equal((await pending).stdout,'done');
  const counts=[];await Promise.all(Array.from({length:5},()=>daemon.withTransferLease(f.c,async()=>{const state=await rpc({op:'status',target:'fixture',config:f.c});counts.push(state.activeChannels);await pause(70);})));assert.ok(counts.every(n=>n<=3));assert.ok(counts.includes(3));
  fs.writeFileSync(path.join(f.local,'source.py'),'source');await sync(f.c,f.local,'sync');assert.equal(fs.readFileSync(path.join(f.remote,'source.py'),'utf8'),'source');assert.equal(f.authCount(),1);
  const job=await startJob(f.c,['bash','-c','sleep 1; echo success']);const waiting=waitJob(f.c,job,5);assert.equal((await remote(f.c,'printf while-waiting')).stdout,'while-waiting');assert.equal((await waiting).status,'completed');assert.match(await logs(f.c,job),/success/);assert.equal(f.authCount(),1);
  const noFallback=await core.run('ssh',[...ssh.masterClientArgs(path.join(f.base,'missing.sock')),'fixture','true'],{timeout:3000});assert.notEqual(noFallback.code,0);assert.equal(f.authCount(),1);
  const small={...f.c,runtime:{...f.c.runtime,maxChannels:1}};await rpc({op:'reconnect',target:'fixture',config:small});assert.equal((await rpc({op:'status',target:'fixture',config:small})).activeChannels,1);
  await daemon.withTransferLease(small,async()=>{const state=await rpc({op:'status',target:'fixture',config:small});assert.equal(state.activeChannels,1);assert.equal(state.controlChannels,0);const summary=await core.run(process.execPath,[path.resolve(__dirname,'../dist/cli.js'),'status'],{cwd:f.local,timeout:3000});assert.equal(summary.code,0,summary.stderr);assert.equal(JSON.parse(summary.stdout).jobs,null);});assert.equal((await remote(small,'printf restored')).stdout,'restored');
 }catch(e){e.message+='\n'+fs.readFileSync(path.join(f.base,'sshd.log'),'utf8');throw e;}finally{await f.cleanup();}
});
test('timeouts and output limits terminate requests; disconnected writes are recovered without replay',async()=>{
 const f=await fixture();try{
  const timed=await remote(f.c,'sleep 2',[],150,1024);assert.equal(timed.code,124);
  const large=await remote(f.c,'head -c 200000 /dev/zero',[],2000,1000);assert.equal(large.code,125);assert.ok(Buffer.byteLength(large.stdout)<=1000);
  // Larger scripts and replies exercise framed IPC rather than the old 64 KiB limit.
  const framed=await remote(f.c,'#'+'x'.repeat(100000)+'\nprintf "%s" "'+('y'.repeat(100000))+'"',[],5000,120000);assert.equal(framed.stdout.length,100000);
  const requestId=crypto.randomUUID(),counter=path.join(f.home,'counter');
  const request=remote(f.c,'printf x >> "$1"; sleep 1; printf finished',[counter],5000,1024,{lane:'blocking',requestId});const failed=assert.rejects(request,{code:'WDX_REQUEST_UNKNOWN'});
  await until(()=>fs.existsSync(counter));const inProgress=await rpc({op:'request-status',target:'fixture',config:f.c,requestId});assert.equal(inProgress.state,'running');assert.equal(inProgress.remoteChecked,true);const socket=ssh.controlPath(await ssh.effective('fixture'));await core.run('ssh',['-S',socket,'-O','exit','fixture']);await failed;
  await rpc({op:'reconnect',target:'fixture',config:f.c});const recovered=await rpc({op:'request-status',target:'fixture',config:f.c,requestId});assert.equal(recovered.state,'completed');assert.equal(recovered.stdout,'finished');assert.equal(fs.readFileSync(counter,'utf8'),'x');
  const job=await startJob(f.c,['bash','-c','sleep 1; echo survived']);const daemonPid=(await rpc({op:'ping'})).pid;process.kill(daemonPid,'SIGTERM');await until(()=>!fs.existsSync(daemon.socketPath()));await ensureDaemon();assert.equal((await waitJob(f.c,job,5)).status,'completed');assert.match(await logs(f.c,job),/survived/);
 }finally{await f.cleanup();}
});
test('authentication failures pause, while network failures back off without connection storms',async()=>{
 const f=await fixture();try{
  await ensureDaemon();
  f.exec('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(f.base,'bad-key')]);
  const configFile=path.join(f.base,'ssh.conf'),original=fs.readFileSync(configFile,'utf8');fs.appendFileSync(configFile,original.replace('Host fixture','Host denied').replace('/client-key','/bad-key'));
  const denied={...f.c,remote:{...f.c.remote,target:'denied'}};
  for(let i=0;i<10;i++)await assert.rejects(()=>rpc({op:'connect',target:'denied',config:denied}),{code:'WDX_AUTH'});
  const paused=await rpc({op:'status',target:'denied',config:denied});assert.equal(paused.state,'auth-paused');assert.equal(paused.connectionAttempts,1);
  const daemonPid=(await rpc({op:'ping'})).pid;process.kill(daemonPid,'SIGTERM');await until(()=>!fs.existsSync(daemon.socketPath()));await ensureDaemon();
  for(let i=0;i<3;i++)await assert.rejects(()=>rpc({op:'connect',target:'denied',config:denied}),{code:'WDX_AUTH'});assert.equal((await rpc({op:'status',target:'denied',config:denied})).connectionAttempts,1);
  const unused=require('node:net').createServer();await new Promise(r=>unused.listen(0,'127.0.0.1',r));const unusedPort=unused.address().port;await new Promise(r=>unused.close(r));
  fs.appendFileSync(configFile,'\nHost unreachable\n HostName 127.0.0.1\n Port '+unusedPort+'\n BatchMode yes\n ConnectTimeout 1\n');const unavailable={...f.c,remote:{...f.c.remote,target:'unreachable'}};
  for(let i=0;i<10;i++)await assert.rejects(()=>rpc({op:'connect',target:'unreachable',config:unavailable}));
  const backoff=await rpc({op:'status',target:'unreachable',config:unavailable});assert.equal(backoff.state,'backoff');assert.equal(backoff.connectionAttempts,1);assert.ok(backoff.retryAfterMs>0);
 }finally{try{await rpc({op:'disconnect',target:'denied'});await rpc({op:'disconnect',target:'unreachable'});}catch{}await f.cleanup();}
});
test('abrupt daemon restart reclaims owned control clients and aliases share one channel budget',async()=>{
 const f=await fixture();try{
  await remote(f.c,':');const before=await rpc({op:'status',target:'fixture',config:f.c});const pid=(await rpc({op:'ping'})).pid;
  process.kill(pid,'SIGKILL');await pause(150);await ensureDaemon();assert.equal((await remote(f.c,'printf adopted')).stdout,'adopted');
  const after=await rpc({op:'status',target:'fixture',config:f.c});assert.equal(after.activeChannels,2);assert.ok(after.controlPids.every(pid=>!before.controlPids.includes(pid)));assert.equal(f.authCount(),1);
  const file=path.join(f.base,'ssh.conf'),original=fs.readFileSync(file,'utf8');fs.appendFileSync(file,original.replace('Host fixture','Host alias'));
  const alias={...f.c,remote:{...f.c.remote,target:'alias'}};const shared=await rpc({op:'connect',target:'alias',config:alias});assert.equal(shared.connectionId,after.connectionId);assert.deepEqual(shared.controlPids,after.controlPids);
  await Promise.all([f.c,alias,f.c,alias].map(c=>daemon.withTransferLease(c,async()=>{assert.ok((await rpc({op:'status',target:'alias',config:alias})).activeChannels<=3);await pause(50);})));assert.equal(f.authCount(),1);
  await assert.rejects(()=>rpc({op:'lease',target:'fixture',config:f.c,pid:1,leaseId:crypto.randomUUID()}),{code:'WDX_IPC'});
  const two={...f.c,runtime:{...f.c.runtime,maxChannels:2}};await rpc({op:'reconnect',target:'fixture',config:two});assert.equal((await rpc({op:'status',target:'fixture',config:two})).controlChannels,1);await daemon.withTransferLease(two,async()=>assert.equal((await rpc({op:'status',target:'fixture',config:two})).activeChannels,2));
 }finally{await f.cleanup();}
});
test('legacy daemon protocol upgrades without losing existing tmux jobs',async()=>{
 const f=await fixture();let legacy;
 try{
  const job=await startJob(f.c,['bash','-c','sleep 2; echo legacy-survived']);const old=(await rpc({op:'ping'})).pid;process.kill(old,'SIGTERM');await until(()=>!fs.existsSync(daemon.socketPath()));
  // Simulate the old newline-JSON IPC protocol and its managed script identity.
  const code=`const net=require('node:net'),fs=require('node:fs');const socket=${JSON.stringify(daemon.socketPath())};const server=net.createServer(s=>{let data='';s.on('data',b=>{data+=b.toString();if(data.includes('\\n'))s.end(JSON.stringify({ok:'pong'})+'\\n');});});server.listen(socket,()=>fs.chmodSync(socket,0o600));process.on('SIGTERM',()=>server.close(()=>{try{fs.unlinkSync(socket);}catch{}process.exit(0);}));`;
  legacy=require('node:child_process').spawn(process.execPath,['-e',code,path.resolve(__dirname,'../dist/daemon-cli.js')],{stdio:'ignore'});await until(()=>fs.existsSync(daemon.socketPath()));
  await ensureDaemon();assert.equal((await rpc({op:'ping'})).version,2);assert.equal((await waitJob(f.c,job,5)).status,'completed');assert.match(await logs(f.c,job),/legacy-survived/);
 }finally{legacy?.kill('SIGTERM');await f.cleanup();}
});
