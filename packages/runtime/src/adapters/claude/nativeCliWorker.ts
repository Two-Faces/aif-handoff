/** Fixed CLI runner embedded in the native worker. It does not import or call
 * the Agent SDK. All argv is generated from the host's admitted options. */
export const NATIVE_CLAUDE_CLI_RUNNER = String.raw`
async function runCli(input, project) {
  const { spawn } = await import('node:child_process');
  const { StringDecoder } = await import('node:string_decoder');
  const options = input.options;
  const args = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--input-format', 'text', '--setting-sources=', '--strict-mcp-config',
    '--mcp-config', JSON.stringify({mcpServers:{}}), '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--settings', JSON.stringify(options.settings)];
  for (const [flag, value] of [['--model', options.model], ['--effort', options.effort],
    ['--max-turns', options.maxTurns], ['--max-budget-usd', options.maxBudgetUsd],
    ['--append-system-prompt', options.systemPrompt?.append]]) {
    if (value !== undefined && value !== '') args.push(flag, String(value));
  }
  args.push('-p');
  const path = options.pathToClaudeCodeExecutable;
  const script = /\.(?:mjs|js)$/.test(path);
  const child = spawn(script ? process.execPath : path, script ? [path, ...args] : args,
    {cwd:options.cwd, env:options.env, stdio:'pipe', windowsHide:true, shell:false});
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('cli_exit')));
  });
  // Count raw bytes, including ignored metadata, before parsing or forwarding.
  // Async stream iteration supplies backpressure while the host drains output.
  let bytes = 0;
  const count = chunk => {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw new Error('cli_output_limit');
  };
  const stdout = (async () => {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    for await (const chunk of child.stdout) {
      count(chunk);
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) await project(JSON.parse(line));
      }
    }
    buffer += decoder.end();
    if (buffer.trim()) await project(JSON.parse(buffer));
  })();
  const stderr = (async () => {
    for await (const chunk of child.stderr) {
      count(chunk);
      if (!process.stderr.write(chunk)) await once(process.stderr, 'drain');
    }
  })();
  const stdin = new Promise((resolve, reject) => {
    child.stdin.once('error', reject);
    child.stdin.end(input.prompt, error => error ? reject(error) : resolve());
  });
  // A rejection emits an opaque worker failure. Only the outer native host
  // stops the complete unit and supplies proof; child close is not that proof.
  await Promise.all([closed, stdout, stderr, stdin]);
}
`;
