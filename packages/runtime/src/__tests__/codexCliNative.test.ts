import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedProcessIdentity, ProcessStopEvidence } from "@aif/shared";
import {
  withNativeProcessScope,
  type NativeProcessLaunchInput,
} from "../supervision/nativeProcessScope.js";
import type { SupervisedProcess } from "../supervision/processSupervisor.js";
import { UsageSource, type RuntimeRunInput } from "../types.js";

const sessionRead = vi.fn();
vi.mock("../adapters/codex/sessions.js", () => ({
  getCodexSessionLimitSnapshot: (...args: unknown[]) => sessionRead(...args),
}));
const { runCodexCli } = await import("../adapters/codex/cli.js");
const { createCodexRuntimeAdapter } = await import("../adapters/codex/index.js");

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function fixture() {
  const id = randomUUID(),
    proof = deferred<ProcessStopEvidence>(),
    ready = deferred<void>();
  const identity: PreparedProcessIdentity = {
    version: 1,
    mechanism: "windows_job_v1",
    id,
    jobName: "Local\\AifHandoff-" + id,
    hostPid: 11,
    hostBirth: "100",
    hostSessionId: 1,
    pid: 12,
    birth: "200",
  };
  const evidence: ProcessStopEvidence = {
    identity,
    activeProcesses: 0,
    reason: "completed",
    exitCode: 0,
    terminatedProcesses: 0,
  };
  const child: SupervisedProcess = {
    identity,
    completed: proof.promise,
    stop: vi.fn(async () => {
      proof.resolve(evidence);
      return proof.promise;
    }),
    write: vi.fn(),
    endInput: vi.fn(() => ready.resolve()),
  };
  const launch = vi.fn(async (_input: NativeProcessLaunchInput) => child);
  const send = (bytes: Buffer | string, stream: "stdout" | "stderr" = "stdout") =>
    launch.mock.calls[0][0].onOutput?.(stream, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return { child, launch, send, ready, proof, evidence };
}
const root = resolve("native-cli-fixture");
const input: RuntimeRunInput = {
  runtimeId: "codex",
  transport: "cli",
  prompt: "Задача 🧪",
  cwd: root,
  options: { codexCliPath: process.execPath },
  usageContext: { source: UsageSource.TEST },
  execution: { runTimeoutMs: 1000 },
};
const output = [
  { type: "thread.started", thread_id: "native-thread" },
  { type: "item.completed", item: { type: "agent_message", text: "Готово 🧪" } },
  { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } },
]
  .map((value) => JSON.stringify(value))
  .join("\n");
function run(f: ReturnType<typeof fixture>, patch: Partial<RuntimeRunInput> = {}) {
  return withNativeProcessScope(root, f.launch, (scope) =>
    runCodexCli({
      ...input,
      ...patch,
      execution: { ...input.execution, ...patch.execution, nativeProcessScope: scope },
    }),
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("native Codex CLI transport", () => {
  it("preserves literal argv, prompt, split UTF-8 and trailing JSONL, waiting for persisted stop without global session reads", async () => {
    const f = fixture(),
      onStderr = vi.fn();
    vi.stubEnv("NODE_OPTIONS", "must-not-reach-child");
    vi.stubEnv("OPENAI_API_KEY", "ambient-key");
    let returned = false;
    const running = run(f, { execution: { onStderr } }).then((value) => {
      returned = true;
      return value;
    });
    await f.ready.promise;
    const launched = f.launch.mock.calls[0][0];
    expect(launched.args).toEqual([
      "exec",
      "--json",
      "-c",
      'approval_policy="on-request"',
      "-c",
      'sandbox_mode="workspace-write"',
    ]);
    expect(launched.environment?.NODE_OPTIONS).toBeUndefined();
    expect(launched.environment?.OPENAI_API_KEY).toBeUndefined();
    expect(
      Buffer.concat(vi.mocked(f.child.write).mock.calls.map(([bytes]) => bytes)).toString(),
    ).toBe(input.prompt);
    for (const byte of Buffer.from(output)) f.send(Buffer.from([byte]));
    for (const byte of Buffer.from("Проверка 🧪")) f.send(Buffer.from([byte]), "stderr");
    expect(returned).toBe(false);
    f.proof.resolve(f.evidence);
    const result = await running;
    expect(result).toMatchObject({
      outputText: "Готово 🧪",
      sessionId: "native-thread",
      usage: { totalTokens: 5 },
    });
    expect(onStderr.mock.calls.flat().join("")).toBe("Проверка 🧪");
    expect(sessionRead).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledOnce();
  });
  it("does not turn zero exit or success output into a result without native proof", async () => {
    const f = fixture(),
      running = run(f);
    const rejected = expect(running).rejects.toThrow("unproved stop");
    await f.ready.promise;
    f.send(output);
    f.proof.reject(new Error("unproved stop"));
    await rejected;
  });
  it.each([
    ["not-json", "native_cli_protocol_invalid"],
    ["null", "native_cli_protocol_invalid"],
    ["[]", "native_cli_protocol_invalid"],
    ['{"type":"turn.failed","error":{"message":"provider failed"}}', "native_cli_turn_failed"],
    ['{"type":"error","message":"provider failed"}', "native_cli_turn_failed"],
    ['{"type":"thread.started","thread_id":"incomplete"}', "native_cli_incomplete"],
  ])("rejects incomplete or failed JSONL %s after stopping", async (text, code) => {
    const f = fixture(),
      running = run(f);
    const rejected = expect(running).rejects.toMatchObject({ adapterCode: code });
    await f.ready.promise;
    f.send(text + "\n");
    f.proof.resolve(f.evidence);
    await rejected;
    expect(f.child.stop).toHaveBeenCalled();
  });
  it("rejects nonzero exit despite a completed turn", async () => {
    const f = fixture(),
      running = run(f);
    const rejected = expect(running).rejects.toMatchObject({
      adapterCode: "native_cli_exit",
      cause: { exitCode: 7 },
    });
    await f.ready.promise;
    f.send(output);
    f.proof.resolve({ ...f.evidence, exitCode: 7 });
    await rejected;
  });
  it("stops on callback failure instead of swallowing it as successful output", async () => {
    const f = fixture(),
      running = run(f, {
        execution: {
          onEvent: () => {
            throw new Error("callback failed");
          },
        },
      });
    const rejected = expect(running).rejects.toMatchObject({
      adapterCode: "native_cli_callback_failed",
    });
    await f.ready.promise;
    f.send(output + "\n");
    await rejected;
    expect(f.child.stop).toHaveBeenCalled();
  });
  it("rejects cancelled runs even with a zero exit and completed turn", async () => {
    const f = fixture(),
      abortController = new AbortController();
    const running = run(f, {
      execution: { abortController, onEvent: () => abortController.abort() },
    });
    const rejected = expect(running).rejects.toMatchObject({ adapterCode: "native_cli_aborted" });
    await f.ready.promise;
    f.send(output + "\n");
    await rejected;
    expect(f.child.stop).toHaveBeenCalled();
  });
  it.each(["start", "run"])("waits for stop on %s timeout and never retries", async (kind) => {
    vi.useFakeTimers();
    const f = fixture(),
      running = run(f, {
        execution: kind === "start" ? { startTimeoutMs: 10 } : { runTimeoutMs: 10 },
      });
    const rejected = expect(running).rejects.toMatchObject({ category: "timeout" });
    await f.ready.promise;
    if (kind === "run") f.send('{"type":"turn.started"}\n');
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.child.stop).toHaveBeenCalled();
  });
  it("bounds collected output even when the consumer drains each chunk", async () => {
    const f = fixture(),
      running = run(f);
    const rejected = expect(running).rejects.toMatchObject({
      adapterCode: "native_cli_output_overflow",
    });
    await f.ready.promise;
    for (let i = 0; i < 17; i++) f.send(Buffer.alloc(1024 * 1024, 32), "stderr");
    await rejected;
  });
  it("rejects pre-abort, unbound sessions, custom argv and unknown transport fallback before launch", async () => {
    const f = fixture(),
      abortController = new AbortController();
    abortController.abort();
    await expect(run(f, { execution: { abortController } })).rejects.toMatchObject({
      adapterCode: "native_cli_aborted",
    });
    for (const patch of [
      { sessionId: "unbound" },
      { resume: true },
      { options: { codexCliArgs: ["exec", "resume", "--last"] } },
    ])
      await expect(run(f, patch)).rejects.toMatchObject({
        adapterCode: "native_cli_input_invalid",
      });
    const adapter = createCodexRuntimeAdapter();
    await expect(
      withNativeProcessScope(root, f.launch, (scope) =>
        adapter.resume!({
          ...input,
          sessionId: "unbound",
          execution: { nativeProcessScope: scope },
        }),
      ),
    ).rejects.toMatchObject({ category: "stream" });
    await expect(
      withNativeProcessScope(root, f.launch, (scope) =>
        adapter.forkSession!({
          ...input,
          sourceSessionId: "unbound",
          execution: { nativeProcessScope: scope },
        }),
      ),
    ).rejects.toMatchObject({ category: "transport" });
    await expect(
      withNativeProcessScope(root, f.launch, (scope) =>
        adapter.run({
          ...input,
          transport: "unknown" as RuntimeRunInput["transport"],
          execution: { nativeProcessScope: scope },
        }),
      ),
    ).rejects.toMatchObject({ category: "transport" });
    expect(f.launch).not.toHaveBeenCalled();
  });
});
