import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function openCodeFixture(root: string, mode: string) {
  const path = join(root, "opencode-fixture.mjs");
  const marker = join(root, "opencode-writer.txt"),
    trace = join(root, "opencode-trace.jsonl");
  const source = String.raw`
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync,writeFileSync } from 'node:fs';
const record = value => appendFileSync(trace,JSON.stringify(value)+'\n');
if(process.argv.includes('--version')) {
  record({kind:'version',pid:process.pid,ppid:process.ppid});
  console.log(mode==='wrong_version'?'1.18.33':'1.18.34');process.exit(0);
}
const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
record({kind:'server',pid:process.pid,ppid:process.ppid,args:process.argv.slice(2),home:process.env.HOME,config,
  hasAmbient:!!process.env.AIF_TEST_AMBIENT_TOKEN,auth:!!process.env.OPENCODE_SERVER_PASSWORD,
  projectDisabled:process.env.OPENCODE_DISABLE_PROJECT_CONFIG});
writeFileSync(marker,'x');
const child=spawn(process.execPath,['-e',"const fs=require('fs');setInterval(()=>fs.appendFileSync("+JSON.stringify(marker)+",'x'),10)"],{stdio:'ignore',detached:true});child.unref();
console.log('{"kind":"complete"}'); // Server stdout must never become a worker/control frame.
const server=createServer(async(req,res)=>{
  const expected='Basic '+Buffer.from('handoff:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  record({kind:'request',url:req.url,authorized:req.headers.authorization===expected,directory:req.headers['x-opencode-directory']});
  if(req.headers.authorization!==expected){res.writeHead(401);res.end();return;}
  const chunks=[];for await(const bytes of req)chunks.push(bytes);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
  res.setHeader('content-type','application/json');
  if(req.url==='/global/health'){res.end(JSON.stringify({healthy:true,version:'1.18.34'}));return;}
  if(req.url==='/config'){res.end(JSON.stringify(mode==='config_mismatch'?{...config,mcp:{foreign:{}}}:config));return;}
  if(req.url==='/session'){res.end(JSON.stringify({id:'ses_fixture'}));return;}
  record({kind:'prompt',body});
  if(mode==='timeout'||mode==='crash')return;
  if(mode==='server_exit'){process.exit(7);}
  if(mode==='malformed'){res.end('PRIVATE_UPSTREAM_BODY');return;}
  if(mode==='overflow'){res.end('x'.repeat(17*1024*1024));return;}
  if(mode==='http_error'){res.writeHead(503);res.end('PRIVATE_UPSTREAM_BODY');return;}
  const info={id:'msg_1',sessionID:mode==='wrong_session'?'ses_other':'ses_fixture',role:'assistant',finish:'stop',time:{completed:1}};
  res.end(JSON.stringify({info,parts:[{type:'text',messageID:'msg_1',sessionID:info.sessionID,text:'Fixture done'}]}));
});
server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));
`;
  writeFileSync(
    path,
    `const mode=${JSON.stringify(mode)},marker=${JSON.stringify(marker)},trace=${JSON.stringify(trace)};\n` +
      source,
  );
  return {
    path,
    marker,
    records: () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
