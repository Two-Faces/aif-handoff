import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { RuntimeExecutionError } from "../errors.js";
import { windowsJobSource } from "./windowsJobSource.js";
import type {
  ProcessHostIdentity,
  PreparedProcessIdentity,
  ProcessStopEvidence,
} from "@aif/shared";
export type {
  ProcessHostIdentity,
  PreparedProcessIdentity,
  ProcessStopEvidence,
} from "@aif/shared";
export interface SupervisedProcess {
  identity: PreparedProcessIdentity;
  completed: Promise<ProcessStopEvidence>;
  stop(): Promise<ProcessStopEvidence>;
  write(bytes: Uint8Array): void;
  endInput(): void;
}
export interface SupervisedProcessInput {
  executable: string;
  args: string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Must durably persist before any target process is created. */
  onIdentity(identity: ProcessHostIdentity): Promise<void>;
  /** Must durably persist before the target's initial thread may run. */
  onPrepared(identity: PreparedProcessIdentity): Promise<void>;
  onOutput?(stream: "stdout" | "stderr", bytes: Buffer): void;
}
type Frame = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const birth = /^[1-9][0-9]{0,19}$/;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function failure(code: string, cause?: unknown): RuntimeExecutionError {
  return new RuntimeExecutionError(
    "Native process supervision could not be verified.",
    cause,
    "transport",
    {
      adapterCode: code,
    },
  );
}
function windowsOnly(): void {
  if (process.platform !== "win32") throw failure("supervisor_unsupported");
}
function validText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && value.length < 32768;
}
function validateIdentity(identity: ProcessHostIdentity): void {
  if (
    identity.version !== 1 ||
    identity.mechanism !== "windows_job_v1" ||
    !uuid.test(identity.id) ||
    identity.jobName !== `Local\\AifHandoff-${identity.id}` ||
    !integer(identity.hostPid) ||
    identity.hostPid === 0 ||
    !integer(identity.hostSessionId) ||
    !birth.test(identity.hostBirth)
  )
    throw failure("supervisor_identity_invalid");
}
function command(input: SupervisedProcessInput, jobName: string): Frame {
  if (
    !validText(input.executable) ||
    !isAbsolute(input.executable) ||
    !input.executable.toLowerCase().endsWith(".exe") ||
    !validText(input.cwd) ||
    !isAbsolute(input.cwd) ||
    !Array.isArray(input.args) ||
    !input.args.every(validText) ||
    input.args.reduce((size, arg) => size + arg.length, 0) > 24000
  )
    throw failure("supervisor_input_invalid");
  const environment: Record<string, string> = {};
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(input.environment ?? process.env)) {
    if (value === undefined) continue;
    if (!key || !validText(key) || key.includes("=") || !validText(value))
      throw failure("supervisor_input_invalid");
    // Windows environment names are case insensitive. Do not pass ambiguous
    // PATH/Path entries whose interpretation depends on the child runtime.
    if (keys.has(key.toLowerCase())) throw failure("supervisor_input_invalid");
    keys.add(key.toLowerCase());
    environment[key] = value;
  }
  return {
    kind: "launch",
    jobName,
    executable: input.executable,
    args: [...input.args],
    cwd: input.cwd,
    environment,
  };
}

/** Compile trusted code in memory. The encoded command never contains args,
 * prompts, credentials, project paths or other task-controlled values. */
function startHost(): ChildProcessWithoutNullStreams {
  const source = Buffer.from(windowsJobSource, "utf8").toString("base64");
  const script = `$ErrorActionPreference = 'Stop'\n[Console]::InputEncoding = [Text.Encoding]::UTF8\n[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))) -ReferencedAssemblies System.Web.Extensions\n[AifJobHost]::Run()\nexit [Environment]::ExitCode`;
  // Passing the source over stdin avoids Windows' command-line length limit.
  // PowerShell reads the script from a separate encoded bootstrap, then the
  // native helper owns the same stream's remaining JSON lines.
  const bootstrap = `$ErrorActionPreference = 'Stop'\nInvoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())))`;
  const host = spawn(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(bootstrap, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  host.stdin.write(Buffer.from(script, "utf8").toString("base64") + "\n");
  return host;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A host can fail before launch() has returned its completion promise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function channel() {
  const host = startHost();
  const closed = deferred<void>();
  let buffer = "",
    failed: unknown,
    handler: (frame: Frame) => Promise<void> = async () => undefined;
  let queue = Promise.resolve();
  let queuedBytes = 0;
  let timer = setTimeout(() => stop(failure("supervisor_start_timeout")), 30000);
  function stop(error: unknown) {
    if (failed) return;
    failed = error;
    closed.reject(error);
    host.stdin.end();
    // Closing or killing the host also closes its sole job handle. Absence of
    // a verified stopped frame still rejects; recovery must inspect the job.
    host.kill();
  }
  host.stdin.on("error", (error) => stop(failure("supervisor_channel_failed", error)));
  host.stderr.on("data", () => {
    /* Never expose scripts or task data as errors. */
  });
  host.stdout.setEncoding("utf8");
  host.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1048576) {
      stop(failure("supervisor_protocol_invalid"));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      queuedBytes += Buffer.byteLength(line);
      if (queuedBytes > 4 * 1024 * 1024) {
        stop(failure("supervisor_output_overflow"));
        return;
      }
      queue = queue
        .then(async () => {
          if (failed) return;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            throw failure("supervisor_protocol_invalid");
          }
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw failure("supervisor_protocol_invalid");
          const frame = value as Frame;
          if (frame.kind === "error")
            throw failure("supervisor_native_failed", { nativeCode: frame.nativeCode });
          await handler(frame);
        })
        .catch(stop)
        .finally(() => {
          queuedBytes -= Buffer.byteLength(line);
        });
    }
  });
  host.on("error", (error) => stop(failure("supervisor_spawn_failed", error)));
  host.on("close", (code) => {
    clearTimeout(timer);
    void queue.then(() => {
      if (failed || code !== 0 || buffer.trim())
        closed.reject(failed ?? failure("supervisor_lost"));
      else closed.resolve();
    });
  });
  return {
    host,
    closed: closed.promise,
    onFrame(callback: typeof handler) {
      handler = callback;
    },
    send(value: Frame) {
      if (failed) throw failed;
      host.stdin.write(JSON.stringify(value) + "\n");
    },
    started() {
      clearTimeout(timer);
    },
    stopping() {
      clearTimeout(timer);
      timer = setTimeout(() => stop(failure("supervisor_stop_timeout")), 30000);
    },
    finish() {
      host.stdin.end();
    },
    fail: stop,
  };
}

/** Internal host primitive. Proves only the dedicated native job is empty.
 * Adapter coverage and durable task/grant binding must be established before
 * using this evidence to release authority; it never starts/accepts a task. */
export async function launchSupervisedProcess(
  input: SupervisedProcessInput,
): Promise<SupervisedProcess> {
  windowsOnly();
  const id = randomUUID(),
    jobName = `Local\\AifHandoff-${id}`;
  const request = command(input, jobName);
  if (input.signal?.aborted) throw failure("supervisor_cancelled");
  const ipc = channel(),
    ready = deferred<SupervisedProcess>(),
    completed = deferred<ProcessStopEvidence>();
  let identity: ProcessHostIdentity | undefined, prepared: PreparedProcessIdentity | undefined;
  let evidence: ProcessStopEvidence | undefined,
    launched = false,
    started = false,
    stopping = false;
  const stop = () => {
    if (stopping || evidence) return completed.promise;
    stopping = true;
    if (launched) {
      ipc.stopping();
      ipc.send({ kind: "stop" });
    }
    return completed.promise;
  };
  const abort = () => {
    try {
      void stop();
    } catch (error) {
      ipc.fail(error);
    }
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  ipc.onFrame(async (frame) => {
    if (frame.kind === "hello" && !identity) {
      if (
        !integer(frame.pid) ||
        frame.pid !== ipc.host.pid ||
        !integer(frame.sessionId) ||
        typeof frame.birth !== "string" ||
        !birth.test(frame.birth)
      )
        throw failure("supervisor_protocol_invalid");
      identity = Object.freeze({
        version: 1,
        mechanism: "windows_job_v1",
        id,
        jobName,
        hostPid: frame.pid,
        hostSessionId: frame.sessionId,
        hostBirth: frame.birth,
      });
      await input.onIdentity(identity);
      if (stopping || input.signal?.aborted) {
        ipc.finish();
        throw failure("supervisor_cancelled");
      }
      ipc.send(request);
      launched = true;
    } else if (frame.kind === "prepared" && identity && !prepared) {
      if (
        frame.jobName !== jobName ||
        !integer(frame.pid) ||
        !frame.pid ||
        typeof frame.birth !== "string" ||
        !birth.test(frame.birth)
      )
        throw failure("supervisor_protocol_invalid");
      prepared = Object.freeze({ ...identity, pid: frame.pid, birth: frame.birth });
      await input.onPrepared(prepared);
      if (!stopping) ipc.send({ kind: "start" });
    } else if (frame.kind === "started" && prepared && !started) {
      started = true;
      ipc.started();
      ready.resolve({
        identity: prepared,
        completed: completed.promise,
        stop,
        write: (bytes) => {
          if (stopping || evidence || bytes.byteLength > 65536)
            throw failure("supervisor_input_invalid");
          ipc.send({ kind: "input", bytes: Buffer.from(bytes).toString("base64") });
        },
        endInput: () => {
          if (!stopping && !evidence) ipc.send({ kind: "endInput" });
        },
      });
    } else if (frame.kind === "output" && prepared) {
      if (
        (frame.stream !== "stdout" && frame.stream !== "stderr") ||
        typeof frame.bytes !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.bytes)
      )
        throw failure("supervisor_protocol_invalid");
      input.onOutput?.(frame.stream, Buffer.from(frame.bytes, "base64"));
    } else if (frame.kind === "stopped" && prepared && !evidence) {
      if (
        frame.jobName !== jobName ||
        frame.activeProcesses !== 0 ||
        !integer(frame.exitCode) ||
        !integer(frame.terminatedProcesses) ||
        (frame.reason !== "completed" &&
          frame.reason !== "cancelled" &&
          frame.reason !== "channel_closed")
      )
        throw failure("supervisor_protocol_invalid");
      evidence = {
        identity: prepared,
        activeProcesses: 0,
        exitCode: frame.exitCode,
        reason: frame.reason,
        terminatedProcesses: frame.terminatedProcesses,
      };
      ipc.finish();
    } else throw failure("supervisor_protocol_invalid");
  });
  void ipc.closed
    .then(() => {
      if (!evidence) throw failure("supervisor_stop_unproven");
      completed.resolve(evidence);
      if (!started) ready.reject(failure("supervisor_cancelled"));
    })
    .catch((error: unknown) => {
      ready.reject(error);
      completed.reject(error);
    })
    .finally(() => input.signal?.removeEventListener("abort", abort));
  return ready.promise;
}

/** The identity must come from the local durable host journal, never peer data
 * or a caller-supplied PID. A reused PID is not killed. No timer grants takeover. */
export async function recoverSupervisedProcess(
  identity: ProcessHostIdentity,
): Promise<ProcessStopEvidence> {
  windowsOnly();
  identity = Object.freeze({ ...identity });
  validateIdentity(identity);
  const ipc = channel();
  let hello = false,
    recovered = false;
  ipc.onFrame(async (frame) => {
    if (frame.kind === "hello" && !hello) {
      if (frame.pid !== ipc.host.pid) throw failure("supervisor_protocol_invalid");
      hello = true;
      ipc.send({
        kind: "recover",
        jobName: identity.jobName,
        hostPid: identity.hostPid,
        hostSessionId: identity.hostSessionId,
        hostBirth: identity.hostBirth,
      });
    } else if (
      frame.kind === "recovered" &&
      hello &&
      !recovered &&
      frame.jobName === identity.jobName &&
      frame.activeProcesses === 0
    ) {
      recovered = true;
      ipc.finish();
    } else throw failure("supervisor_protocol_invalid");
  });
  await ipc.closed;
  if (!recovered) throw failure("supervisor_stop_unproven");
  return {
    identity,
    activeProcesses: 0,
    reason: "recovered",
    exitCode: null,
    terminatedProcesses: null,
  };
}
