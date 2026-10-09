// Inspect and install exactly the tarball that npm would publish.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'werodex-release-'));
const run=(cmd,args,opts={})=>execFileSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,...opts});
try{
 const output=run('npm',['pack','--json','--pack-destination',tmp]);
 const packed=JSON.parse(output.slice(output.indexOf('[\n')))[0];
 const tarball=path.join(tmp,packed.filename);
 const names=run('tar',['-tzf',tarball]).trim().split('\n');
 const allowed=/^package\/(dist\/(?:[^/]+\.js|mcp\.mjs|remote-worker\.py)|docs\/[^/]+\.md|examples\/[^/]+\.json|werodex_skills\/werodex-init\/(SKILL\.md|agents\/openai\.yaml|references\/[^/]+\.md)|assets\/WerodexBar\.jpg|package\.json|README(?:-CN)?\.md|LICENSE|SECURITY\.md)$/;
 const secret=/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{24,}|\bnpm_[A-Za-z0-9]{20,}/;
 for(const name of names){
  if(!allowed.test(name))throw Error('Unexpected publish file: '+name);
  if(!name.endsWith('.jpg')&&secret.test(run('tar',['-xOf',tarball,name])))throw Error('Potential credential in publish file: '+name);
 }
 for(const name of ['dist/cli.js','dist/daemon-cli.js','dist/askpass.js','dist/mcp.mjs','dist/remote-worker.py','assets/WerodexBar.jpg','werodex_skills/werodex-init/SKILL.md'])if(!names.includes('package/'+name))throw Error('Missing package file: '+name);
 const prefix=path.join(tmp,'global');
 run('npm',['install','-g','--prefix',prefix,'--no-audit','--no-fund',tarball]);
 const help=run(path.join(prefix,'bin','werodex'),['help']);
 if(!help.includes('git-tree')||!help.includes('sync'))throw Error('Installed CLI smoke check failed');
 console.log(`Release check passed: ${packed.filename}; ${names.length} files; isolated global installation works.`);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
