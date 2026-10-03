import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedProcessIdentity, ProcessStopEvidence } from "@aif/shared";
import type { SupervisedProcess } from "../supervision/processSupervisor.js";
import {
  withNativeProcessScope,
  type NativeProcessLaunchInput,
} from "../supervision/nativeProcessScope.js";
import { UsageSource, type RuntimeRunInput } from "../types.js";
import { parseNativeClaudeFrame } from "../adapters/claude/nativeProtocol.js";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  find: vi.fn(),
  probe: vi.fn(),
  bundled: vi.fn(() => ({ major: 2, minor: 1, patch: 220, raw: "2.1.220" })),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));
vi.mock("../adapters/claude/findPath.js", async (original) => ({
  ...(await original<typeof import("../adapters/claude/findPath.js")>()),
  findClaudePath: mocks.find,
}));
vi.mock("../adapters/claude/version.js", async (original) => ({
  ...(await original<typeof import("../adapters/claude/version.js")>()),
  assertClaudeExecutableCompatible: mocks.probe,
  readBundledClaudeVersion: mocks.bundled,
}));
const { createClaudeRuntimeAdapter } = await import("../adapters/claude/index.js");
const { runClaudeRuntime } = await import("../adapters/claude/run.js");
const { runClaudeCli } = await import("../adapters/claude/cli.js");
const { runClaudeQueryAttempt } = await import("../adapters/claude/stream.js");
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
    write: vi.fn(),
    endInput: vi.fn(() => ready.resolve()),
    stop: vi.fn(async () => {
      proof.resolve(evidence);
      return proof.promise;
    }),
  };
  const launch = vi.fn(async (_input: NativeProcessLaunchInput) => child);
  const send = (frame: unknown) =>
    launch.mock.calls[0][0].onOutput?.("stdout", Buffer.from(JSON.stringify(frame) + "\n"));
  return { proof, ready, evidence, child, launch, send };
}
const root = resolve("native-claude-fixture");
const input: RuntimeRunInput = {
  runtimeId: "claude",
  providerId: "anthropic",
  transport: "sdk",
  prompt: "Задача 🧪",
  cwd: root,
  usageContext: { source: UsageSource.TEST },
  execution: { runTimeoutMs: 1000 },
};
const init = { kind: "init", sessionId: "session" };
const result = {
  kind: "result",
  sessionId: "session",
  subtype: "success",
  isError: false,
  text: "Готово 🧪",
  usage: { input_tokens: 2, output_tokens: 3 },
  cost: 0.01,
};
function run(f: ReturnType<typeof fixture>, patch: Partial<RuntimeRunInput> = {}) {
  return withNativeProcessScope(root, f.launch, (scope) =>
    createClaudeRuntimeAdapter({ logger }).run({
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
describe("native Claude SDK worker", () => {
  it("keeps discovery, version probes and SDK query out of the host and fences callback/results until proof", async () => {
    const f = fixture(),
      onToolUse = vi.fn(),
      onSubagentStart = vi.fn(),
      onEvent = vi.fn();
    vi.stubEnv("NODE_OPTIONS", "must-not-reach-worker");
    const running = run(f, {
      options: { apiKey: "private-fixture-secret" },
      execution: { onToolUse, onSubagentStart, onEvent, systemPromptAppend: "Russian" },
    });
    await f.ready.promise;
    const launch = f.launch.mock.calls[0][0];
    expect(launch.args.join(" ")).not.toContain("private-fixture-secret");
    expect(launch.environment?.NODE_OPTIONS).toBeUndefined();
    expect(launch.environment?.ANTHROPIC_API_KEY).toBeUndefined();
    const payload = JSON.parse(
      Buffer.concat(vi.mocked(f.child.write).mock.calls.map(([bytes]) => bytes)).toString(),
    );
    expect(payload).toMatchObject({
      version: 1,
      prompt: input.prompt,
      options: {
        cwd: root,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        persistSession: false,
        systemPrompt: { append: "Russian" },
        env: { ANTHROPIC_API_KEY: "private-fixture-secret" },
      },
    });
    expect(payload.options.env.NODE_OPTIONS).toBeUndefined();
    f.send(init);
    f.send({ kind: "text", text: "Готово 🧪" });
    f.send({ kind: "tool_use", id: "tool", name: "Bash", input: { command: "test" } });
    f.send({ kind: "tool_done", name: "Bash", input: { command: "test" } });
    f.send({ kind: "subagent", name: "reviewer", id: "agent" });
    f.send(result);
    f.send({ kind: "complete" });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.proof.resolve(f.evidence);
    expect(await running).toMatchObject({
      outputText: "Готово 🧪",
      sessionId: "session",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: 0.01 },
    });
    expect(onToolUse).toHaveBeenCalledWith("Bash", " `test`");
    expect(onSubagentStart).toHaveBeenCalledWith("reviewer", "agent");
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "stream:text" }));
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it.each([
    "no_result",
    "no_worker",
    "foreign_session",
    "duplicate_init",
    "late_event",
    "nonzero",
    "unproven",
    "error_result",
    "is_error",
  ])("refuses false completion: %s", async (mode) => {
    const f = fixture(),
      running = run(f);
    const rejected = expect(running).rejects.toBeInstanceOf(Error);
    await f.ready.promise;
    f.send(init);
    if (mode === "duplicate_init") f.send(init);
    if (mode !== "no_result")
      f.send({
        ...result,
        sessionId: mode === "foreign_session" ? "foreign" : "session",
        subtype: mode === "error_result" ? "error_max_turns" : "success",
        isError: mode === "is_error",
      });
    if (mode !== "no_worker") f.send({ kind: "complete" });
    if (mode === "late_event") f.send({ kind: "text", text: "late" });
    if (mode === "unproven") f.proof.reject(new Error("unproven"));
    else f.proof.resolve({ ...f.evidence, exitCode: mode === "nonzero" ? 1 : 0 });
    await rejected;
  });
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
          if (mode === "callback") throw new Error("callback");
        },
      },
    });
    const rejected = expect(running).rejects.toBeInstanceOf(Error);
    await f.ready.promise;
    if (mode !== "start") f.send(init);
    if (mode === "abort") abortController.abort();
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.child.stop).toHaveBeenCalled();
  });
  it("rejects unbound sessions, hooks, environment, permission bypass and unknown options before launch", async () => {
    const f = fixture();
    for (const patch of [
      { sessionId: "old" },
      { resume: true },
      { headers: {} },
      { options: { settings: {} } },
      { execution: { hooks: {} } },
      { execution: { environment: {} } },
      { execution: { outputSchema: {} } },
      { execution: { agentDefinitionName: "agent" } },
      { execution: { bypassPermissions: true } },
      { options: { claudeCliPath: 42 } },
    ])
      await expect(run(f, patch)).rejects.toMatchObject({
        adapterCode: "native_claude_input_invalid",
      });
    await expect(run(f, { prompt: "x".repeat(1024 * 1024) })).rejects.toMatchObject({
      adapterCode: "native_claude_input_limit",
    });
    const adapter = createClaudeRuntimeAdapter({ logger });
    for (const operation of [
      (i: RuntimeRunInput) => adapter.resume!({ ...i, sessionId: "old" }),
      (i: RuntimeRunInput) => adapter.forkSession!({ ...i, sourceSessionId: "old" }),
      (i: RuntimeRunInput) => runClaudeCli(i),
      (i: RuntimeRunInput) => runClaudeQueryAttempt(i, {}),
      (i: RuntimeRunInput) => runClaudeRuntime({ ...i, transport: "api" }, logger),
    ])
      await expect(
        withNativeProcessScope(root, f.launch, (scope) =>
          operation({ ...input, execution: { nativeProcessScope: scope } }),
        ),
      ).rejects.toMatchObject({ category: "transport" });
    expect(f.launch).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("fails closed on an old bundled artifact without consulting the host probe cache", async () => {
    mocks.bundled.mockReturnValueOnce({ major: 2, minor: 1, patch: 190, raw: "2.1.190" });
    const f = fixture();
    await expect(run(f)).rejects.toMatchObject({
      adapterCode: "native_claude_version_unsupported",
    });
    expect(f.launch).not.toHaveBeenCalled();
  });
});
describe("native Claude frame projection", () => {
  it.each([
    null,
    { kind: "stopped", activeProcesses: 0 },
    { kind: "init", sessionId: 0 },
    { kind: "tool_done", name: "Bash", input: [] },
    { ...result, usage: { input_tokens: -1, output_tokens: 3 } },
    { ...result, cost: Infinity },
    { ...result, isError: "false" },
    { kind: "error", code: "injected" },
  ])("rejects invalid frame %j", (frame) => {
    expect(() => parseNativeClaudeFrame(JSON.stringify(frame))).toThrow(
      expect.objectContaining({ adapterCode: "native_claude_protocol_invalid" }),
    );
  });
  it.each(["worker_failed", "version_unsupported"])("keeps %s opaque", (code) => {
    expect(() =>
      parseNativeClaudeFrame(JSON.stringify({ kind: "error", code, message: "private" })),
    ).toThrow(
      expect.objectContaining({
        adapterCode: "native_claude_" + code,
        message: "Native Claude SDK attempt failed",
      }),
    );
  });
});
