import { EventEmitter } from "node:events";
import { accessSync, realpathSync, statSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { PassThrough, Writable, type Readable } from "node:stream";
import type { RuntimeRunInput } from "../types.js";
import { RuntimeExecutionError } from "../errors.js";
import type { SupervisedProcess, SupervisedProcessInput } from "./processSupervisor.js";

/** Internal host capability. JSON/profile options cannot create a valid scope. */
export interface NativeProcessScope {
  readonly nativeProcessScope: true;
}
export type NativeProcessLaunchInput = Omit<SupervisedProcessInput, "onIdentity" | "onPrepared">;
export type NativeProcessLauncher = (input: NativeProcessLaunchInput) => Promise<SupervisedProcess>;
export interface RuntimeStdioProcess extends EventEmitter {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

interface ScopeState {
  root: string;
  launcher: NativeProcessLauncher;
  used: boolean;
  closed: boolean;
  abort: AbortController;
  process?: Promise<SupervisedStdioProcess>;
}
const scopes = new WeakMap<NativeProcessScope, ScopeState>();
function failure(code: string, cause?: unknown) {
  return new RuntimeExecutionError(
    "Native runtime process supervision failed: " + code,
    cause,
    "transport",
    { adapterCode: code },
  );
}
function stateOf(scope: NativeProcessScope): ScopeState {
  const state = scopes.get(scope);
  if (!state || state.closed) throw failure("native_scope_invalid");
  return state;
}
export function assertNativeProcessMode(input: RuntimeRunInput, supported: boolean): void {
  const scope = input.execution?.nativeProcessScope;
  if (scope === undefined) return;
  stateOf(scope);
  if (!supported) throw failure("native_transport_unsupported");
}

/** One adapter attempt, one native unit. A result is returned only after its
 * stop promise (including the host's durable journal acknowledgement) succeeds.
 * This is not a claim that external services are contained, and never releases
 * device authority. The host must retain personal execution and handoff gates. */
export async function withNativeProcessScope<T>(
  root: string,
  launcher: NativeProcessLauncher,
  operation: (scope: NativeProcessScope) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(root)) throw failure("native_scope_root_invalid");
  const scope: NativeProcessScope = Object.freeze({ nativeProcessScope: true });
  const state: ScopeState = {
    root: resolve(root),
    launcher,
    used: false,
    closed: false,
    abort: new AbortController(),
  };
  scopes.set(scope, state);
  try {
    const result = await operation(scope);
    if (!state.used) throw failure("native_launch_missing");
    return result;
  } finally {
    state.closed = true;
    state.abort.abort();
    if (state.process) await (await state.process).stop();
  }
}

/** Resolve a literal executable without invoking a shell. Windows command
 * wrappers are not native executables and require a separate audited path. */
export function resolveNativeExecutable(command: string, env: NodeJS.ProcessEnv): string {
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const candidates = isAbsolute(command)
    ? [command]
    : !command.includes("/") && !command.includes("\\")
      ? path
          .split(delimiter)
          .filter(isAbsolute)
          .flatMap((directory) =>
            process.platform === "win32" && !command.toLowerCase().endsWith(".exe")
              ? [join(directory, command + ".exe")]
              : [join(directory, command)],
          )
      : [];
  for (const candidate of candidates) {
    if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) continue;
    try {
      const executable = realpathSync(candidate);
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return executable;
    } catch {
      /* Try the next literal PATH entry. */
    }
  }
  throw failure("native_executable_unavailable");
}

/** libuv supplies these OS essentials for normal Node spawn on Windows. Native
 * CreateProcess receives exactly our environment block, so supply the same
 * defaults without reintroducing provider credentials or runtime overrides. */
export function nativeProcessEnvironment(
  input: NodeJS.ProcessEnv,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...input };
  if (platform !== "win32") return environment;
  const required = new Set([
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
  ]);
  const present = new Set(
    Object.entries(environment)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key.toUpperCase()),
  );
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (value !== undefined && required.has(upper) && !present.has(upper)) {
      environment[key] = value;
      present.add(upper);
    }
  }
  return environment;
}

/** Minimal stdio process surface used by protocol adapters. Exit/close mean
 * native stop has been verified and persisted, not merely that a PID exited. */
export class SupervisedStdioProcess extends EventEmitter implements RuntimeStdioProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private child?: SupervisedProcess;
  private error: unknown;
  private completion?: Promise<void>;
  constructor() {
    super();
    this.on("error", () => undefined);
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        try {
          if (!this.child || this.error) throw this.error ?? failure("native_process_not_ready");
          for (let offset = 0; offset < chunk.length; offset += 65536)
            this.child.write(chunk.subarray(offset, offset + 65536));
          callback();
        } catch (error) {
          this.fail(error);
          callback(error instanceof Error ? error : failure("native_input_failed", error));
        }
      },
      final: (callback) => {
        try {
          this.child?.endInput();
          callback();
        } catch (error) {
          this.fail(error);
          callback(error instanceof Error ? error : failure("native_input_failed", error));
        }
      },
    });
    this.stdin.on("error", (error) => this.fail(error));
  }
  output = (stream: "stdout" | "stderr", bytes: Buffer): void => {
    if (this.error) return;
    const target = this[stream];
    if (target.readableLength + target.writableLength + bytes.length > 4 * 1024 * 1024) {
      this.fail(failure("native_output_overflow"));
      return;
    }
    target.write(bytes);
  };
  attach(child: SupervisedProcess): void {
    this.child = child;
    this.pid = child.identity.pid;
    this.completion = child.completed.then(
      (evidence) => {
        this.exitCode = evidence.exitCode;
        this.stdout.end();
        this.stderr.end();
        this.stdin.destroy();
        this.emit("exit", this.exitCode, null);
        this.emit("close", this.exitCode, null);
        if (this.error) throw this.error;
      },
      (error) => {
        this.fail(error);
        this.stdout.end();
        this.stderr.end();
        this.stdin.destroy();
        this.emit("close", null, null);
        throw error;
      },
    );
    void this.completion.catch(() => undefined);
    if (this.error) void child.stop().catch(() => undefined);
  }
  private fail(error: unknown): void {
    if (this.error) return;
    this.error = error;
    this.emit("error", error);
    if (this.child) void this.child.stop().catch(() => undefined);
  }
  kill(_signal?: NodeJS.Signals | number): boolean {
    if (!this.child || this.exitCode !== null || this.error) return false;
    void this.stop().catch((error) => this.fail(error));
    return true;
  }
  async stop(): Promise<void> {
    if (!this.child) throw failure("native_process_not_ready");
    await this.child.stop();
    await this.completion;
  }
}

export async function launchNativeStdioProcess(
  scope: NativeProcessScope,
  input: Omit<NativeProcessLaunchInput, "onOutput">,
): Promise<SupervisedStdioProcess> {
  const state = stateOf(scope);
  if (state.used || relative(state.root, resolve(input.cwd)) !== "")
    throw failure("native_scope_conflict");
  const environment = nativeProcessEnvironment(input.environment ?? process.env);
  const executable = resolveNativeExecutable(input.executable, environment);
  state.used = true;
  const stdio = new SupervisedStdioProcess();
  state.process = (async () => {
    const signal = input.signal
      ? AbortSignal.any([input.signal, state.abort.signal])
      : state.abort.signal;
    const child = await state.launcher({
      ...input,
      executable,
      environment,
      signal,
      onOutput: stdio.output,
    });
    stdio.attach(child);
    return stdio;
  })();
  void state.process.catch(() => undefined);
  return state.process;
}
