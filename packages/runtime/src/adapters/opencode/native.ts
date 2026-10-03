import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  RuntimeEvent,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeSessionForkInput,
} from "../../types.js";
import {
  assertNativeProcessMode,
  nativeProcessEnvironment,
  resolveNativeExecutable,
} from "../../supervision/nativeProcessScope.js";
import { runNativeBatch } from "../../supervision/nativeBatch.js";
import { nativeOpenCodeFailure, parseNativeOpenCodeFrame } from "./nativeProtocol.js";
import { NATIVE_OPENCODE_WORKER } from "./nativeWorker.js";

export const NATIVE_OPENCODE_VERSION = "1.18.34";
/** Dedicated local server only. baseUrl/server credentials never select an external executor. */
export function assertNativeOpenCodeInput(input: RuntimeRunInput): void {
  const allowed = new Set([
    "opencodeCliPath",
    "modelBaseUrl",
    "apiKey",
    "contextWindow",
    "maxOutputTokens",
  ]);
  const execution = input.execution;
  if (
    (input.transport !== undefined && input.transport !== "api") ||
    input.resume ||
    input.sessionId ||
    (input as Partial<RuntimeSessionForkInput>).sourceSessionId ||
    input.headers !== undefined ||
    !input.model ||
    !/^[a-zA-Z0-9_./:-]+$/.test(input.model) ||
    execution?.hooks !== undefined ||
    execution?.environment !== undefined ||
    execution?.outputSchema !== undefined ||
    execution?.agentDefinitionName !== undefined ||
    execution?.bypassPermissions ||
    Object.keys(input.options ?? {}).some((key) => !allowed.has(key))
  )
    throw nativeOpenCodeFailure("input_invalid");
  const options = input.options ?? {};
  if (typeof options.modelBaseUrl !== "string" || /[{}]/.test(options.modelBaseUrl))
    throw nativeOpenCodeFailure("input_invalid");
  let url: URL;
  try {
    url = new URL(options.modelBaseUrl);
  } catch {
    throw nativeOpenCodeFailure("input_invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw nativeOpenCodeFailure("input_invalid");
  if (
    options.apiKey !== undefined &&
    (typeof options.apiKey !== "string" || /[{}]/.test(options.apiKey))
  )
    throw nativeOpenCodeFailure("input_invalid");
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const value = options[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1048576)
    )
      throw nativeOpenCodeFailure("input_invalid");
  }
  if (Number(options.maxOutputTokens ?? 4096) >= Number(options.contextWindow ?? 32768))
    throw nativeOpenCodeFailure("input_invalid");
}

/** The npm shim can move with fnm sessions. Resolve its installed native package
 * by files only; never invoke a shim/version probe outside the native unit. */
export function resolveOpenCodeExecutable(command: string): string {
  if (/\.(?:mjs|js)$/.test(command) && isAbsolute(command) && statSync(command).isFile())
    return realpathSync(command);
  const executable = resolveNativeExecutable(command, process.env);
  if (process.platform === "win32") return executable;
  if (
    dirname(executable).endsWith("opencode-ai/bin") ||
    dirname(executable).endsWith("opencode-ai")
  ) {
    const packageRoot = dirname(executable).endsWith("/bin")
      ? dirname(dirname(executable))
      : dirname(executable);
    const name = `opencode-${process.platform}-${process.arch}`;
    for (const path of [
      join(packageRoot, "node_modules", name, "bin", "opencode"),
      join(dirname(packageRoot), name, "bin", "opencode"),
    ]) {
      if (existsSync(path)) return resolveNativeExecutable(path, process.env);
    }
    throw nativeOpenCodeFailure("executable_unavailable");
  }
  return executable;
}

function assertConfiguration(root: string) {
  // The v2 core loader also discovers project files. Until config admission is
  // audited end to end, fail before launch rather than trusting a disabling flag.
  let current = root;
  while (true) {
    if (
      ["opencode.json", "opencode.jsonc", ".opencode"].some((name) =>
        existsSync(join(current, name)),
      )
    )
      throw nativeOpenCodeFailure("project_config_unsupported");
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  const paths =
    process.platform === "darwin"
      ? [
          "/Library/Application Support/opencode/opencode.json",
          "/Library/Application Support/opencode/opencode.jsonc",
          "/Library/Managed Preferences/ai.opencode.managed.plist",
          join("/Library/Managed Preferences", userInfo().username, "ai.opencode.managed.plist"),
        ]
      : ["opencode.json", "opencode.jsonc"].map((name) =>
          join(process.env.ProgramData ?? "C:\\ProgramData", "opencode", name),
        );
  if (paths.some((path) => existsSync(path))) throw nativeOpenCodeFailure("managed_config");
}

export async function runNativeOpenCode(input: RuntimeRunInput): Promise<RuntimeRunResult> {
  assertNativeProcessMode(input, true);
  assertNativeOpenCodeInput(input);
  if (!input.execution?.nativeProcessScope) throw nativeOpenCodeFailure("scope_required");
  const cwd = input.cwd ?? input.projectRoot ?? "";
  if (!isAbsolute(cwd)) throw nativeOpenCodeFailure("input_invalid");
  assertConfiguration(cwd);
  const configured = input.options?.opencodeCliPath ?? process.env.OPENCODE_CLI_PATH ?? "opencode";
  if (typeof configured !== "string" || !configured) throw nativeOpenCodeFailure("input_invalid");
  const executable = resolveOpenCodeExecutable(configured);
  const payload = {
    version: 1,
    expectedVersion: NATIVE_OPENCODE_VERSION,
    cwd,
    executable,
    model: input.model,
    modelBaseUrl: input.options!.modelBaseUrl,
    apiKey: input.options?.apiKey ?? "local",
    contextWindow: input.options?.contextWindow ?? 32768,
    maxOutputTokens: input.options?.maxOutputTokens ?? 4096,
    prompt: input.prompt,
    system: [input.systemPrompt, input.execution?.systemPromptAppend].filter(Boolean).join("\n\n"),
    // No inherited OpenCode/Node/auth/config variables reach the child server.
    environment: nativeProcessEnvironment({
      PATH: process.env.PATH ?? process.env.Path,
      ...(process.platform === "win32" ? {} : { PATH: process.env.PATH ?? "/usr/bin:/bin" }),
    }),
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024 - 8192)
    throw nativeOpenCodeFailure("input_limit");
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, "aif-opencode-"));
  const events: RuntimeEvent[] = [];
  let ready = false,
    sessionId: string | null = null,
    outputText: string | null = null,
    complete = false;
  const emit = (event: RuntimeEvent) => {
    events.push(event);
    input.execution?.onEvent?.(event);
  };
  return runNativeBatch({
    input,
    stdin: JSON.stringify({ ...payload, directory }),
    runTimeoutMs: input.execution?.runTimeoutMs,
    command: {
      executable: process.execPath,
      args: ["--input-type=module", "-e", NATIVE_OPENCODE_WORKER],
      environment: nativeProcessEnvironment({}),
    },
    failure: nativeOpenCodeFailure,
    afterStopped: () => {
      const path = resolve(directory);
      if (dirname(path) !== parent || !relative(parent, path).startsWith("aif-opencode-"))
        throw nativeOpenCodeFailure("cleanup_invalid");
      rmSync(path, { recursive: true, force: true });
    },
    line: (line) => {
      const frame = parseNativeOpenCodeFrame(line);
      if (complete) throw nativeOpenCodeFailure("protocol_invalid");
      if (frame.kind === "ready") {
        if (ready) throw nativeOpenCodeFailure("protocol_invalid");
        ready = true;
        emit({
          type: "system:init",
          timestamp: new Date().toISOString(),
          message: "Owned OpenCode server ready",
        });
      } else if (frame.kind === "session") {
        if (!ready || sessionId) throw nativeOpenCodeFailure("protocol_invalid");
        sessionId = frame.id;
      } else if (frame.kind === "result") {
        if (!sessionId || frame.sessionId !== sessionId || outputText !== null)
          throw nativeOpenCodeFailure("protocol_invalid");
        outputText = frame.text;
        emit({
          type: "stream:text",
          timestamp: new Date().toISOString(),
          message: outputText,
          data: { text: outputText },
        });
      } else {
        if (outputText === null) throw nativeOpenCodeFailure("incomplete");
        complete = true;
      }
    },
    complete: () => {
      if (!complete || !sessionId || outputText === null) throw nativeOpenCodeFailure("incomplete");
      // Preserve OpenCode's existing NONE usage contract until all paths expose accounting.
      return { outputText, sessionId, events, usage: null };
    },
  });
}
