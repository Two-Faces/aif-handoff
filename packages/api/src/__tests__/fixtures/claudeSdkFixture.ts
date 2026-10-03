import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Actual Agent SDK speaks its initialization/hook protocol to this offline
 * CLI. No SDK, supervisor, journal or process topology is mocked. */
export function claudeSdkFixture(
  root: string,
  mode: "success" | "abort" | "timeout" | "malformed" | "old_version" | "nonzero",
) {
  const path = join(root, "claude-fixture.mjs");
  const marker = join(root, "claude-writer.txt");
  writeFileSync(
    path,
    `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const topology = {pid:process.pid,ppid:process.ppid,cwd:process.cwd(),argv:process.argv};
if(process.argv.includes('--version')) {
  fs.writeFileSync('claude-version.json', JSON.stringify(topology));
  process.stdout.write(mode === 'old_version' ? '2.1.190' : '2.1.220');
} else {
  fs.writeFileSync('claude-launch.json', JSON.stringify(topology));
  const writer = require('node:child_process').spawn(process.execPath, ['-e',
    ${JSON.stringify("setInterval(()=>require('node:fs').appendFileSync(" + JSON.stringify(marker) + ",'x'),10)")}
  ], {stdio:'ignore',detached:true,windowsHide:true});
  writer.unref();
  const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
  const session = '573e8787-875e-400d-b919-dbe3431f1f99';
  let initialized, user, sent = false, pending = 0;
  function result() {
    if(pending || mode === 'abort' || mode === 'timeout') return;
    const message = {type:'result',subtype:'success',session_id:session,is_error:false,result:'Claude result 🧪',
      usage:{input_tokens:2,output_tokens:3},total_cost_usd:0.01,duration_ms:1,duration_api_ms:1,num_turns:1};
    process.stdout.write(JSON.stringify(message)+'\\n',()=>process.exit(mode === 'nonzero' ? 7 : 0));
  }
  function emit() {
    if(!initialized || !user || sent) return;
    if(!fs.existsSync(${JSON.stringify(marker)})) {setTimeout(emit,5);return;}
    sent = true;
    fs.writeFileSync('claude-prompt.json',JSON.stringify(user.message));
    process.stderr.write('Claude fixture stderr');
    if(mode === 'malformed') {process.stdout.write('PRIVATE_CLAUDE_PARSE_ERROR\\n',()=>process.exit(1));return;}
    send({type:'system',subtype:'init',session_id:session});
    send({type:'stream_event',session_id:session,event:{type:'content_block_delta',delta:{type:'text_delta',text:mode === 'abort' ? 'abort now' : 'Claude result 🧪'}}});
    send({type:'assistant',session_id:session,message:{role:'assistant',content:[{type:'tool_use',id:'tool',name:'Bash',input:{command:'fixture'}}]}});
    for(const [event,input] of [
      ['PostToolUse',{tool_name:'Bash',tool_input:{command:'fixture'},tool_response:'ok',tool_use_id:'tool'}],
      ['SubagentStart',{agent_type:'reviewer',agent_id:'agent'}]
    ]) {
      const callback = initialized.hooks[event][0].hookCallbackIds[0];
      pending++;
      send({type:'control_request',request_id:event,request:{subtype:'hook_callback',callback_id:callback,
        input:{hook_event_name:event,session_id:session,cwd:process.cwd(),...input}}});
    }
  }
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const message = JSON.parse(line);
    if(message.type === 'control_request' && message.request.subtype === 'initialize') {
      initialized = message.request;
      fs.writeFileSync('claude-initialize.json',JSON.stringify(initialized));
      send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{commands:[],models:[],agents:[]}}});
      emit();
    } else if(message.type === 'user') {user=message;emit();}
    else if(message.type === 'control_response') {
      if(message.response.subtype !== 'success') process.exit(9);
      pending--;result();
    }
  });
}
`,
  );
  return { path, marker };
}
