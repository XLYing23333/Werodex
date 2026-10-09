const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
module.exports=async function(request){
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'wdx-native-worker-'));
 try{
  const result=cp.spawnSync('python3',[path.resolve(__dirname,'../dist/remote-worker.py'),'oneshot'],{input:JSON.stringify({...request,state}),encoding:'utf8',maxBuffer:16*1024*1024});
  if(result.status){const message=result.stderr.trim();const code=message.match(/(WDX_[A-Z_]+):/)?.[1]??'WDX_NATIVE';const e=Error(message);e.code=code;throw e;}
  const value=JSON.parse(result.stdout);return {code:0,stdout:'',stderr:'',value:value.value};
 }finally{fs.rmSync(state,{recursive:true,force:true});}
};
