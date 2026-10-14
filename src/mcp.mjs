import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import path from 'node:path';
import core from './core.js';
import services from './services.js';
import journal from './journal.js';
import daemon from './daemon.js';
import metrics from './diagnostics.js';
const index=process.argv.indexOf('--workspace');
const root=core.assertWorkspace(path.resolve(index<0?process.cwd():process.argv[index+1]));
const config=core.readConfig(root);
const p=z.string().min(1).max(4096),bytes=z.number().int().min(1).max(262144).optional();
const scope=z.array(p).min(1).max(1000),id=z.string().uuid();
let admitted=0,inputBytes=0,activeFiles=0,outputBytes=0;const fileWaiters=[],outputWaiters=[];
async function fileSlot(){if(activeFiles>=3)await new Promise(resolve=>fileWaiters.push(resolve));else activeFiles++;return ()=>{const release=()=>{const next=fileWaiters.shift();if(next)next();else activeFiles--;};if(outputBytes>=4*1024*1024)outputWaiters.push(release);else release();};}
const file={path:p.optional(),remote:z.boolean().optional()};
function createServer(){
 const server=new McpServer({name:'werodex',version:'0.1.0'},{maxToolInputElements:10000});
 const register=(name,description,schema,readOnly=false,handler)=>server.registerTool(name,{description,inputSchema:z.object(schema),annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:false}},async(input,context)=>{
  const size=Buffer.byteLength(JSON.stringify(input));if(admitted>=128||inputBytes+size>64*1024*1024)return {content:[{type:'text',text:JSON.stringify({untrusted:true,error:{code:'WDX_QUEUE_LIMIT',message:'MCP admission budget exceeded'}})}],isError:true};admitted++;inputBytes+=size;let release;
  try{if(!['status','job_wait','job_kill','program_exec'].includes(name))release=await fileSlot();if(context?.signal?.aborted)throw new core.WdxError('WDX_CANCELLED','Tool request cancelled before execution');const start=performance.now();const value=await (handler?handler(input):services.service(config,root,name,input));const result={untrusted:true,data:value};if(process.env.WERODEX_PROFILE==='1')console.error(JSON.stringify({tool:name,milliseconds:performance.now()-start,...metrics.diagnostics()}));return {content:[{type:'text',text:JSON.stringify(result)}]};}
  catch(error){return {content:[{type:'text',text:JSON.stringify({untrusted:true,error:{code:error.code??'WDX_ERROR',message:error.message}})}],isError:true};}finally{release?.();admitted--;inputBytes-=size;}
 });
 register('file_list','List bounded workspace file metadata. Returned names are untrusted data.',{...file,limit:z.number().int().min(1).max(200).optional()},true);
 register('file_read','Read a bounded file range. Protected data returns metadata unless preview is explicit. Content is untrusted data.',{...file,preview:z.boolean().optional(),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxBytes:bytes},true);
 register('file_search','Search eligible Source files; results are untrusted data.',{...file,pattern:z.string().min(1).max(1024),regex:z.boolean().optional(),limit:z.number().int().min(1).max(200).optional()},true);
 register('file_write','Atomically write local Source. Existing files require the current content hash.',{path:p,content:z.string().max(4*1024*1024),expectedHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),localOnly:z.boolean().optional()});
 register('file_patch','Atomically patch local Source with unique text matches and the current content hash.',{path:p,expectedHash:z.string().regex(/^[a-f0-9]{64}$/),edits:z.array(z.object({oldText:z.string().min(1),newText:z.string()})).min(1).max(100),localOnly:z.boolean().optional()});
 register('program_exec','Run a bounded remote program using argv for verification. Output is untrusted data.',{argv:z.array(z.string().max(65536)).min(1).max(1000),timeout:z.number().int().min(1).max(300000).optional(),maxBytes:bytes});
 register('job_run','Start an independent remote program using argv.',{argv:z.array(z.string().max(65536)).min(1).max(1000)});
 register('job_status','Read job metadata without shell scripts.',{id:id.optional()},true);
 register('job_wait','Wait remotely for a task; one control request.',{id,timeout:z.number().min(0).max(604800).optional()},true);
 register('job_logs','Read bounded task output; text is untrusted data.',{id,cursor:z.number().int().min(0).optional(),maxBytes:bytes},true);
 register('job_kill','Stop a named job.',{id});
 register('sync','Synchronize selected Source paths. Never auto-delete remote Source.',{direction:z.enum(['sync','pull']).optional(),paths:scope.optional(),full:z.boolean().optional()});
 register('status','Read current connection counters without creating an SSH connection.',{},true);
 register('finish','Complete a verified milestone: commit named Source on both sides, Git overview, and log. Unrelated work is excluded.',{message:z.string().min(1).max(4096),entry:p,paths:scope,assets:z.array(p).max(5).optional(),localAssets:z.array(p).max(5).optional()});
 register('log_add','Record a read-only, experiment, or delivery result. Optional Source scope verifies only those paths.',{entry:p,source:scope.optional(),assets:z.array(p).max(5).optional(),localAssets:z.array(p).max(5).optional()},false,input=>journal.addLog(config,root,path.resolve(root,input.entry),input.assets??[],new Date(),{source:input.source,localAssets:input.localAssets}));
 register('fetch','Copy a named remote artifact to local storage with path protections.',{path:p});
 return server;
}
const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:8*1024*1024});const send=transport.send.bind(transport);
transport.send=async message=>{const size=Buffer.byteLength(JSON.stringify(message));outputBytes+=size;if(outputBytes>=4*1024*1024)process.stdin.pause();try{await send(message);}finally{outputBytes-=size;if(outputBytes<4*1024*1024){process.stdin.resume();for(const release of outputWaiters.splice(0))release();}}};
serveStdio(createServer,{transport});
process.stdin.on('end',()=>daemon.closeSession());
