/** One bounded HTTP request in a native unit. Prompt, headers and proxy secrets
 * arrive on stdin; this worker has no tool runner or repository API. */
export const NATIVE_HTTP_WORKER = String.raw`
import { once } from 'node:events';
const write = async value => {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('frame_limit');
  if (!process.stdout.write(text)) await once(process.stdout, 'drain');
};
let dispatcher;
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('input_limit');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input.version !== 1 || input.cwd !== process.cwd() ||
      typeof input.stream !== 'boolean') throw new Error('input_invalid');
  const { fetch, Agent, ProxyAgent } = await import(process.argv[1]);
  dispatcher = input.proxy ? new ProxyAgent({uri:input.proxy,bodyTimeout:0,headersTimeout:0}) :
    new Agent({bodyTimeout:0,headersTimeout:0});
  const response = await fetch(input.url, {method:'POST', headers:input.headers,
    body:JSON.stringify(input.body), redirect:'error', dispatcher});
  const headers = {};
  for (const [key,value] of response.headers) if (key === 'retry-after' || key.startsWith('x-ratelimit-'))
    headers[key] = value;
  await write({kind:'headers',status:response.status,headers});
  if (!response.ok) {
    await response.body?.cancel();
    process.exitCode = 1;
  } else {
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!response.body || (input.stream ? mime !== 'text/event-stream' : mime !== 'application/json'))
      throw new Error('content_type');
    const decoder = new TextDecoder('utf-8', {fatal:true});
    let buffer = '', bytes = 0, done = false, data = [];
    const dispatch = async () => {
      if (!data.length) return;
      const text = data.join('\n');
      data = [];
      if (done) throw new Error('event_after_done');
      if (text === '[DONE]') {done = true;await write({kind:'done'});}
      else await write({kind:'payload',payload:JSON.parse(text)});
    };
    const line = async text => {
      if (text.endsWith('\r')) text = text.slice(0,-1);
      if (!text) return dispatch();
      if (text.startsWith(':')) return;
      const colon = text.indexOf(':');
      const name = colon < 0 ? text : text.slice(0,colon);
      let value = colon < 0 ? '' : text.slice(colon+1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (name === 'data') data.push(value);
    };
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) throw new Error('body_limit');
      buffer += decoder.decode(chunk,{stream:true});
      if (input.stream) {
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const text = buffer.slice(0,newline);
          buffer = buffer.slice(newline+1);
          await line(text);
        }
      }
    }
    buffer += decoder.decode();
    if (input.stream) {
      if (buffer) await line(buffer);
      await dispatch();
      if (!done) throw new Error('missing_done');
    } else await write({kind:'payload',payload:JSON.parse(buffer)});
    await write({kind:'complete'});
  }
} catch {
  // Never echo an upstream body, URL, request headers or parser exception.
  await write({kind:'error',code:'worker_failed'}).catch(() => undefined);
  process.exitCode = 1;
} finally {
  try { await dispatcher?.destroy(); } catch { process.exitCode = 1; }
}
`;
