import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedProcessIdentity, ProcessStopEvidence } from "@aif/shared";
import type { SupervisedProcess } from "../supervision/processSupervisor.js";
import {
  withNativeProcessScope,
  type NativeProcessLaunchInput,
} from "../supervision/nativeProcessScope.js";
import { UsageSource, type RuntimeRunInput } from "../types.js";
import { parseNativeSdkFrame } from "../adapters/codex/nativeSdkProtocol.js";

const constructor = vi.fn(),
  sessionRead = vi.fn();
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor() {
      constructor();
    }
  },
}));
vi.mock("../adapters/codex/sessions.js", () => ({
  getCodexSessionLimitSnapshot: (...args: unknown[]) => sessionRead(...args),
}));
const { runCodexSdk } = await import("../adapters/codex/sdk.js");
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
  const send = (value: unknown) =>
    launch.mock.calls[0][0].onOutput?.("stdout", Buffer.from(JSON.stringify(value) + "\n"));
  return { child, launch, proof, ready, evidence, send };
}
const root = resolve("native-sdk-fixture");
const input: RuntimeRunInput = {
  runtimeId: "codex",
  transport: "sdk",
  prompt: "Задача 🧪",
  cwd: root,
  options: { codexCliPath: process.execPath },
  usageContext: { source: UsageSource.TEST },
  execution: { runTimeoutMs: 1000 },
};
const started = { type: "thread.started", thread_id: "sdk-thread" };
const turn = {
  type: "turn.completed",
  usage: { input_tokens: 2, output_tokens: 3, cached_input_tokens: 1 },
};
const complete = { kind: "complete", sessionId: "sdk-thread" };
function run(f: ReturnType<typeof fixture>, patch: Partial<RuntimeRunInput> = {}) {
  return withNativeProcessScope(root, f.launch, (scope) =>
    runCodexSdk({
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

describe("native Codex SDK worker", () => {
  it("keeps the SDK out of the host, sends secrets only through bounded stdin and holds results for native proof", async () => {
    const f = fixture(),
      onToolUse = vi.fn(),
      onEvent = vi.fn();
    vi.stubEnv("NODE_OPTIONS", "must-not-reach-worker");
    const running = run(f, {
      options: { codexCliPath: process.execPath, apiKey: "explicit-test-secret" },
      execution: { onToolUse, onEvent, systemPromptAppend: "Russian" },
    });
    await f.ready.promise;
    const launched = f.launch.mock.calls[0][0];
    expect(launched.executable).toBe(realpathSync(process.execPath));
    expect(launched.args.join(" ")).not.toContain("explicit-test-secret");
    expect(launched.environment?.NODE_OPTIONS).toBeUndefined();
    expect(launched.environment?.OPENAI_API_KEY).toBeUndefined();
    const payload = JSON.parse(
      Buffer.concat(vi.mocked(f.child.write).mock.calls.map(([bytes]) => bytes)).toString(),
    );
    expect(payload).toMatchObject({
      version: 1,
      prompt: "Russian\n\nЗадача 🧪",
      codex: { apiKey: "explicit-test-secret" },
      thread: { workingDirectory: root },
    });
    expect(payload.codex.env.NODE_OPTIONS).toBeUndefined();
    f.send({ kind: "event", event: started });
    f.send({
      kind: "event",
      event: {
        type: "item.completed",
        item: {
          id: "tool",
          type: "command_execution",
          command: "test",
          aggregated_output: "ok",
          status: "completed",
          exit_code: 0,
        },
      },
    });
    f.send({
      kind: "event",
      event: {
        type: "item.completed",
        item: { id: "text", type: "agent_message", text: "Готово 🧪" },
      },
    });
    f.send({ kind: "event", event: turn });
    f.send(complete);
    let returned = false;
    void running.then(() => {
      returned = true;
    });
    expect(returned).toBe(false);
    f.proof.resolve(f.evidence);
    expect(await running).toMatchObject({
      outputText: "Готово 🧪",
      sessionId: "sdk-thread",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    expect(onToolUse).toHaveBeenCalledWith("Bash", "test");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stream:text", message: "Готово 🧪" }),
    );
    expect(constructor).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });
  it.each([
    [null, "protocol_invalid"],
    [{ kind: "stopped", activeProcesses: 0 }, "protocol_invalid"],
    [{ kind: "error", code: "sdk_worker_failed" }, "worker_failed"],
    [
      { kind: "event", event: { type: "turn.failed", error: { message: "private" } } },
      "turn_failed",
    ],
    [complete, "incomplete"],
  ])("rejects malformed, forged or failed worker frames: %j", async (frame, code) => {
    const f = fixture(),
      running = run(f);
    const rejected = expect(running).rejects.toMatchObject({ adapterCode: "native_sdk_" + code });
    await f.ready.promise;
    f.send(frame);
    await rejected;
    expect(f.child.stop).toHaveBeenCalled();
  });
  it.each(["no_turn", "no_worker", "wrong_session", "late_event", "nonzero", "unproven"])(
    "refuses a false completion: %s",
    async (mode) => {
      const f = fixture(),
        running = run(f);
      const rejected = expect(running).rejects.toBeInstanceOf(Error);
      await f.ready.promise;
      f.send({ kind: "event", event: started });
      if (mode !== "no_turn") f.send({ kind: "event", event: turn });
      if (mode !== "no_worker")
        f.send({ ...complete, sessionId: mode === "wrong_session" ? "foreign" : "sdk-thread" });
      if (mode === "late_event") f.send({ kind: "event", event: { type: "turn.started" } });
      if (mode === "unproven") f.proof.reject(new Error("native proof missing"));
      else f.proof.resolve({ ...f.evidence, exitCode: mode === "nonzero" ? 1 : 0 });
      await rejected;
    },
  );
  it.each(["start", "run", "abort", "callback"])("stops on %s without retry", async (mode) => {
    vi.useFakeTimers();
    const f = fixture(),
      abortController = new AbortController();
    const running = run(f, {
      execution: {
        abortController,
        startTimeoutMs: mode === "start" ? 10 : undefined,
        runTimeoutMs: 20,
        onEvent: () => {
          if (mode === "callback") throw new Error("callback failed");
        },
      },
    });
    const rejected = expect(running).rejects.toBeInstanceOf(Error);
    await f.ready.promise;
    if (mode !== "start") f.send({ kind: "event", event: started });
    if (mode === "abort") abortController.abort();
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.child.stop).toHaveBeenCalled();
  });
  it("rejects unsupported session/options and oversize input before launch, including adapter resume/fork", async () => {
    const f = fixture();
    for (const patch of [
      { sessionId: "foreign" },
      { resume: true },
      { options: { codexConfig: {} } },
      { options: { codexCliArgs: [] } },
      { execution: { outputSchema: {} } },
      { execution: { hooks: {} } },
      { execution: { environment: {} } },
    ])
      await expect(run(f, patch)).rejects.toMatchObject({
        adapterCode: "native_sdk_input_invalid",
      });
    await expect(run(f, { prompt: "x".repeat(1024 * 1024) })).rejects.toMatchObject({
      adapterCode: "native_sdk_input_limit",
    });
    const adapter = createCodexRuntimeAdapter();
    await expect(
      withNativeProcessScope(root, f.launch, (scope) =>
        adapter.resume!({
          ...input,
          sessionId: "foreign",
          execution: { nativeProcessScope: scope },
        }),
      ),
    ).rejects.toMatchObject({ category: "stream" });
    await expect(
      withNativeProcessScope(root, f.launch, (scope) =>
        adapter.forkSession!({
          ...input,
          sourceSessionId: "foreign",
          execution: { nativeProcessScope: scope },
        }),
      ),
    ).rejects.toMatchObject({ category: "transport" });
    expect(f.launch).not.toHaveBeenCalled();
  });
});

describe("native SDK protocol projection", () => {
  it.each([
    { type: "agent_message", text: "text" },
    { type: "reasoning", text: "summary" },
    {
      type: "command_execution",
      command: "test",
      aggregated_output: "",
      status: "failed",
      exit_code: -1,
    },
    { type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "completed" },
    {
      type: "mcp_tool_call",
      server: "local",
      tool: "read",
      arguments: {},
      status: "completed",
      result: { ignored: true },
    },
    { type: "web_search", query: "example" },
    { type: "error", message: "nonfatal" },
    { type: "todo_list", items: [{ text: "step", completed: false }] },
  ])("projects supported item %j", (item) => {
    const frame = parseNativeSdkFrame(
      JSON.stringify({
        kind: "event",
        event: { type: "item.completed", item: { id: "i", ...item } },
      }),
    );
    expect(frame).toMatchObject({
      kind: "event",
      event: { type: "item.completed", item: { id: "i", type: item.type } },
    });
    if (frame.kind === "event" && frame.event.type === "item.completed")
      expect(frame.event.item).not.toHaveProperty("result");
  });
  it.each([
    { type: "turn.completed", usage: { input_tokens: -1 } },
    { type: "turn.completed", usage: null },
    { type: "item.completed", item: null },
    { type: "item.completed", item: { id: "i", type: "file_change", changes: [null] } },
    {
      type: "item.completed",
      item: { id: "i", type: "todo_list", items: [{ text: "step", completed: "true" }] },
    },
    {
      type: "item.completed",
      item: {
        id: "i",
        type: "command_execution",
        command: "test",
        aggregated_output: "",
        status: "completed",
        exit_code: 1.5,
      },
    },
    { type: "item.completed", item: { id: "i", type: "unknown" } },
    { type: "thread.started", thread_id: 1 },
  ])("rejects invalid event before host callbacks: %j", (event) => {
    expect(() => parseNativeSdkFrame(JSON.stringify({ kind: "event", event }))).toThrow(
      expect.objectContaining({ adapterCode: "native_sdk_protocol_invalid" }),
    );
  });
});
