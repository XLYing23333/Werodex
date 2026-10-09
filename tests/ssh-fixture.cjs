const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),net=require('node:net');
const {defaultConfig,atomicJson}=require('../dist/core');
const {ensureLocalManagedIgnore}=require('../dist/review');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
async function fixture(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'wdx-sshd-')),local=path.join(base,'local'),remote=path.join(base,'remote'),home=path.join(base,'remote-home'),bin=path.join(base,'bin'),tmux=path.join(base,'tmux');
 for(const dir of [local,remote,home,bin,tmux])fs.mkdirSync(dir,{mode:0o700});
 const exec=(file,args,options={})=>cp.execFileSync(file,args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],...options});
 const prior={PATH:process.env.PATH,HOME:process.env.HOME,WERODEX_STATE_DIR:process.env.WERODEX_STATE_DIR};let server;
 async function cleanup(){
  try{const daemon=require('../dist/daemon');const ping=await daemon.rpc({op:'ping'},1000);await daemon.rpc({op:'disconnect',target:'fixture',config:c},15000);process.kill(ping.pid,'SIGTERM');}catch{}
  for(const name of ['werodex-control','default'])try{exec('tmux',['-L',name,'kill-server'],{env:{...process.env,TMUX_TMPDIR:tmux}});}catch{}
  server?.kill('SIGTERM');await pause(200);
  for(const [key,value] of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;
  fs.rmSync(base,{recursive:true,force:true});
 }
 let c;
 try{
  exec('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(base,'host-key')]);exec('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(base,'client-key')]);
  fs.copyFileSync(path.join(base,'client-key.pub'),path.join(base,'authorized_keys'));fs.chmodSync(path.join(base,'authorized_keys'),0o600);
  const temporary=net.createServer();await new Promise(r=>temporary.listen(0,'127.0.0.1',r));const port=temporary.address().port;await new Promise(r=>temporary.close(r));
  const force=path.join(base,'force.sh');fs.writeFileSync(force,'#!/bin/bash\nexport HOME='+quote(home)+'\nexport TMUX_TMPDIR='+quote(tmux)+'\nexec bash --noprofile --norc -c "$SSH_ORIGINAL_COMMAND"\n',{mode:0o700});
  fs.writeFileSync(path.join(base,'sshd.conf'),`Port ${port}\nListenAddress 127.0.0.1\nHostKey ${base}/host-key\nPidFile ${base}/sshd.pid\nAuthorizedKeysFile ${base}/authorized_keys\nStrictModes no\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nAllowUsers ${os.userInfo().username}\nForceCommand ${force}\nLogLevel VERBOSE\n`);
  fs.writeFileSync(path.join(base,'known_hosts'),`[127.0.0.1]:${port} ${exec('ssh-keygen',['-y','-f',path.join(base,'host-key')]).trim()}\n`);
  fs.writeFileSync(path.join(base,'ssh.conf'),`Host fixture\n HostName 127.0.0.1\n User ${os.userInfo().username}\n Port ${port}\n IdentityFile ${base}/client-key\n IdentitiesOnly yes\n UserKnownHostsFile ${base}/known_hosts\n StrictHostKeyChecking yes\n LogLevel ERROR\n`);
  fs.writeFileSync(path.join(bin,'ssh'),'#!/bin/sh\nexec /usr/bin/ssh -F '+quote(path.join(base,'ssh.conf'))+' "$@"\n',{mode:0o700});
  process.env.PATH=bin+path.delimiter+prior.PATH;process.env.HOME=path.join(base,'client-home');fs.mkdirSync(process.env.HOME,{mode:0o700});process.env.WERODEX_STATE_DIR=path.join(base,'state');
  server=cp.spawn('/usr/sbin/sshd',['-D','-e','-f',path.join(base,'sshd.conf'),'-E',path.join(base,'sshd.log')],{stdio:'ignore'});
  await pause(200);if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(base,'sshd.log'),'utf8'));
  for(const dir of [local,remote]){exec('git',['init','-q','-b','main',dir]);exec('git',['config','user.name','Fixture'],{cwd:dir});exec('git',['config','user.email','fixture@example.invalid'],{cwd:dir});ensureLocalManagedIgnore(dir);}
  c=defaultConfig('fixture',remote);atomicJson(path.join(local,'.werodex/config.json'),c);atomicJson(path.join(local,'.werodex/review.json'),{status:'complete'});
  require('../dist/ssh').clearEffectiveCache('fixture');
  return {base,local,remote,home,tmux,c,exec,cleanup,server,authCount:()=>((fs.readFileSync(path.join(base,'sshd.log'),'utf8').match(/Accepted publickey/g))??[]).length};
 }catch(e){await cleanup();throw e;}
}
module.exports={fixture,pause};
