/** Fixed one-shot Node worker. It imports the host-resolved, pinned SDK only
 * after the native launch barriers and bounded stdin payload. No DB, dynamic
 * module option, shell, resume or temporary output-schema file is admitted. */
export const NATIVE_CODEX_SDK_WORKER = String.raw`
import { once } from 'node:events';
const write = async value => {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('frame_limit');
  if (!process.stdout.write(text)) await once(process.stdout, 'drain');
};
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
      input.thread?.workingDirectory !== process.cwd()) throw new Error('input_invalid');
  const { Codex } = await import(process.argv[1]);
  const thread = new Codex(input.codex).startThread(input.thread);
  const { events } = await thread.runStreamed(input.prompt);
  for await (const event of events) {
    await write({ kind: 'event', event });
  }
  await write({ kind: 'complete', sessionId: thread.id });
} catch {
  // SDK errors may contain the entire prompt, malformed output or credentials.
  // The fixed code is diagnostic data; it cannot claim native stop or authority.
  await write({ kind: 'error', code: 'sdk_worker_failed' }).catch(() => undefined);
  process.exitCode = 1;
}
`;
