/** One native unit owns this worker, its fresh server, probes and descendants.
 * Server stdout is data, never the host's protocol or a native stop receipt. */
export const NATIVE_OPENCODE_WORKER = String.raw`
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
const write = value => new Promise((resolve,reject) => process.stdout.write(JSON.stringify(value)+'\n', error => error ? reject(error) : resolve()));
let code = 'worker_failed', status, server, timer;
try {
  const chunks=[];
  let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(input.version!==1 || input.cwd!==process.cwd() || typeof input.directory!=='string')throw new Error();
  chmodSync(input.directory,0o700);
  const dirs=Object.fromEntries(['home','config','data','cache','state','tmp'].map(name=>[name,join(input.directory,name)]));
  for(const dir of Object.values(dirs))mkdirSync(dir,{recursive:true,mode:0o700});
  const password=randomBytes(32).toString('hex');
  const config={
    model:'handoff/'+input.model,small_model:'handoff/'+input.model,
    enabled_providers:['handoff'],autoupdate:false,share:'disabled',snapshot:false,
    formatter:false,lsp:false,mcp:{},plugin:[],instructions:[],
    permission:{'*':'deny',read:'allow',glob:'allow',grep:'allow',list:'allow',edit:'allow',bash:'allow'},
    agent:{build:{steps:8}},
    provider:{handoff:{npm:'@ai-sdk/openai-compatible',name:'Handoff model',
      options:{baseURL:input.modelBaseUrl,apiKey:input.apiKey,maxRetries:0},
      models:{[input.model]:{name:input.model,tool_call:true,limit:{context:input.contextWindow,output:input.maxOutputTokens}}}}}
  };
  const env={...input.environment,HOME:dirs.home,USERPROFILE:dirs.home,
    XDG_CONFIG_HOME:dirs.config,XDG_DATA_HOME:dirs.data,XDG_CACHE_HOME:dirs.cache,XDG_STATE_HOME:dirs.state,
    TMPDIR:dirs.tmp,TMP:dirs.tmp,TEMP:dirs.tmp,
    OPENCODE_TEST_HOME:dirs.home,OPENCODE_CONFIG_CONTENT:JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:'true',OPENCODE_DISABLE_FFF:'true',
    OPENCODE_DISABLE_EMBEDDED_WEB_UI:'true',OPENCODE_DISABLE_AUTOCOMPACT:'true',OPENCODE_DISABLE_PRUNE:'true',
    OPENCODE_SERVER_USERNAME:'handoff',OPENCODE_SERVER_PASSWORD:password,
    npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_ignore_scripts:'true'
  };
  const script=/\.(?:mjs|js)$/.test(input.executable);
  const executable=script?process.execPath:input.executable;
  const prefix=script?[input.executable]:[];
  const version=await new Promise((resolve,reject)=>execFile(executable,[...prefix,'--version'],
    {env,cwd:input.cwd,windowsHide:true,timeout:10000,maxBuffer:16384},
    (error,stdout)=>error?reject(error):resolve(stdout.trim())));
  if(version!==input.expectedVersion){code='version_unsupported';throw new Error();}
  const dead=new AbortController();
  server=spawn(executable,[...prefix,'serve','--hostname','127.0.0.1','--port','0'],{env,cwd:input.cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let rawBytes=0,buffer='',announced=false;
  const url=await new Promise((resolve,reject)=>{
    const fail=(failure)=>{code=failure;dead.abort();reject(new Error());};
    timer=setTimeout(()=>fail('server_start_timeout'),15000);
    server.once('error',()=>fail('server_exit'));
    server.once('exit',()=>fail('server_exit'));
    const collect=(stream,chunk)=>{
      rawBytes+=chunk.length;
      if(rawBytes>4*1024*1024){fail('server_output_limit');return;}
      if(stream!=='stdout'||announced)return;
      buffer+=chunk.toString('utf8');
      let end;
      while((end=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
        const match=/^opencode server listening on http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(line);
        if(!match)continue;
        const port=Number(match[1]);if(port<1||port>65535){fail('server_exit');return;}
        announced=true;clearTimeout(timer);resolve('http://127.0.0.1:'+port);return;
      }
    };
    server.stdout.on('data',chunk=>collect('stdout',chunk));
    server.stderr.on('data',chunk=>collect('stderr',chunk));
  });
  const json=(path,body)=>new Promise((resolve,reject)=>{
    if(dead.signal.aborted){reject(new Error());return;}
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    // Node HTTP avoids browser bad-port rules for an OS-assigned private server.
    // No proxy, redirect, reconnect, external baseUrl or existing-server attach.
    const req=request(url+path,{method:bytes?'POST':'GET',signal:dead.signal,headers:{
      authorization:'Basic '+Buffer.from('handoff:'+password).toString('base64'),
      'x-opencode-directory':encodeURIComponent(input.cwd),
      ...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{})
    }},res=>{
      if(res.statusCode!==200){code='http_status';status=res.statusCode;res.destroy();reject(new Error());return;}
      const chunks=[];let total=0;
      res.on('data',chunk=>{total+=chunk.length;if(total>16*1024*1024){code='response_limit';res.destroy(new Error());}else chunks.push(chunk);});
      res.once('error',reject);
      res.once('end',()=>{try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(new Error());}});
    });
    req.once('error',reject);req.end(bytes);
  });
  const health=await json('/global/health');
  if(health.healthy!==true||health.version!==input.expectedVersion){code='version_unsupported';throw new Error();}
  const effective=await json('/config');
  if(effective.snapshot!==false||effective.share!=='disabled'||effective.lsp!==false||effective.formatter!==false||
    Object.keys(effective.mcp??{}).length||(effective.plugin??[]).length||effective.model!==config.model){code='config_mismatch';throw new Error();}
  await write({kind:'ready'});
  const session=await json('/session',{title:'Handoff task'});
  if(typeof session.id!=='string'||!/^ses_[a-zA-Z0-9]+$/.test(session.id))throw new Error();
  await write({kind:'session',id:session.id});
  const result=await json('/session/'+session.id+'/message',{
    model:{providerID:'handoff',modelID:input.model},agent:'build',
    parts:[{type:'text',text:input.prompt}],...(input.system?{system:input.system}:{})
  });
  if(dead.signal.aborted)throw new Error();
  await write({kind:'result',payload:result});
  await write({kind:'complete'});
  // Root exit asks the native supervisor to stop ALL server descendants. No
  // HTTP abort response or worker PID exit is accepted as native stop proof.
  process.exit(0);
} catch {
  await write({kind:'error',code,status}).catch(()=>undefined);
  process.exit(1);
} finally {clearTimeout(timer);}
`;
