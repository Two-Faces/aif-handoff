/** Fixed worker: both the real Agent SDK and its CLI live inside the native
 * unit. Credentials/prompt arrive only over bounded stdin, after both barriers.
 * SDK messages are data, never process-stop evidence or device authority. */
export const NATIVE_CLAUDE_WORKER = String.raw`
import { once } from 'node:events';
import { execFile } from 'node:child_process';
const write = async value => {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('frame_limit');
  if (!process.stdout.write(text)) await once(process.stdout, 'drain');
};
let session;
let failureCode = 'worker_failed';
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('input_limit');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input.version !== 1 || typeof input.prompt !== 'string' ||
      input.options?.cwd !== process.cwd()) throw new Error('input_invalid');
  const options = input.options;
  // Explicit executables are probed here, inside the same native unit. Never
  // invoke the legacy host version probe or rely on its test bypass/cache.
  if (options.pathToClaudeCodeExecutable) {
    const path = options.pathToClaudeCodeExecutable;
    const script = /\.(?:mjs|js)$/.test(path);
    const raw = await new Promise((resolve, reject) => execFile(
      script ? process.execPath : path,
      script ? [path, '--version'] : ['--version'],
      { cwd: options.cwd, env: options.env, windowsHide: true, timeout: 4000, maxBuffer: 16384 },
      (error, stdout) => error ? reject(error) : resolve(stdout)
    ));
    const version = /^(?:.*?)(\d+)\.(\d+)\.(\d+)/.exec(raw);
    const actual = version?.slice(1).map(Number);
    const minimum = input.minimumVersion.split('.').map(Number);
    let comparison = 0;
    if (actual) for (let i = 0; i < 3 && !comparison; i++) comparison = actual[i] - minimum[i];
    if (!actual || comparison < 0) {
      failureCode = 'version_unsupported';
      throw new Error('version_unsupported');
    }
  }
  Object.assign(process.env, options.env);
  const { query } = await import(process.argv[1]);
  session = query({ prompt: input.prompt, options: {
    ...options,
    executable: process.execPath,
    stderr: text => process.stderr.write(text),
    hooks: {
      PostToolUse: [{ hooks: [async event => {
        await write({kind:'tool_done', name:event.tool_name, input:event.tool_input});
        return {};
      }]}],
      SubagentStart: [{ hooks: [async event => {
        await write({kind:'subagent', name:event.agent_type, id:event.agent_id});
        return {};
      }]}]
    }
  }});
  for await (const event of session) {
    if (event.type === 'system' && event.subtype === 'init')
      await write({kind:'init', sessionId:event.session_id});
    else if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' &&
             event.event.delta?.type === 'text_delta')
      await write({kind:'text', text:event.event.delta.text});
    else if (event.type === 'assistant') {
      for (const item of event.message?.content ?? []) if (item.type === 'tool_use')
        await write({kind:'tool_use', id:item.id, name:item.name, input:item.input});
    } else if (event.type === 'result')
      await write({kind:'result', sessionId:event.session_id, subtype:event.subtype,
        isError:event.is_error, text:event.result ?? '', usage:event.usage,
        cost:event.total_cost_usd});
  }
  await write({kind:'complete'});
} catch {
  // Raw SDK errors can echo malformed provider data or private prompts.
  await write({kind:'error', code:failureCode}).catch(() => undefined);
  process.exitCode = 1;
} finally {
  try { session?.close(); } catch { process.exitCode = 1; }
}
`;
