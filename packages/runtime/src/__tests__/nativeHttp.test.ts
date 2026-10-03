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
import { createCodexRuntimeAdapter } from "../adapters/codex/index.js";
import { createOpenRouterRuntimeAdapter } from "../adapters/openrouter/index.js";
import { createOpenCodeRuntimeAdapter } from "../adapters/opencode/index.js";
import { createOpenCodeSession, runOpenCodeApi } from "../adapters/opencode/api.js";
import { parseNativeHttpFrame } from "../adapters/chatCompletion/nativeProtocol.js";

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
  const payload = () =>
    JSON.parse(Buffer.concat(vi.mocked(child.write).mock.calls.map(([bytes]) => bytes)).toString());
  return { proof, ready, evidence, child, launch, send, payload };
}
const root = resolve("native-http-fixture");
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const input: RuntimeRunInput = {
  runtimeId: "codex",
  transport: "api",
  model: "fixture-model",
  prompt: "Задача 🧪",
  cwd: root,
  options: { baseUrl: "https://provider.invalid/v1", apiKey: "fixture-secret" },
  usageContext: { source: UsageSource.TEST },
  execution: { runTimeoutMs: 1000 },
};
const headers = { kind: "headers", status: 200, headers: {} };
const tokenUsage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.01 };
const chunk = (content: string | null, finish: string | null = null, usage?: unknown) => ({
  kind: "payload",
  payload: {
    id: "request",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  },
});
const answer = {
  kind: "payload",
  payload: {
    id: "request",
    choices: [{ index: 0, message: { content: "Готово 🧪" }, finish_reason: "stop" }],
    usage: tokenUsage,
  },
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(["codex", "openrouter"] as const)("native %s HTTP", (provider) => {
  function run(f: ReturnType<typeof fixture>, patch: Partial<RuntimeRunInput> = {}) {
    const adapter =
      provider === "codex"
        ? createCodexRuntimeAdapter({ logger })
        : createOpenRouterRuntimeAdapter({ logger });
    return withNativeProcessScope(root, f.launch, (scope) =>
      adapter.run({
        ...input,
        runtimeId: provider,
        ...patch,
        execution: { ...input.execution, ...patch.execution, nativeProcessScope: scope },
      }),
    );
  }
  function finish(f: ReturnType<typeof fixture>) {
    f.send(chunk(null, "stop"));
    f.send(
      provider === "codex"
        ? { kind: "payload", payload: { id: "request", choices: [], usage: tokenUsage } }
        : chunk("", "stop", tokenUsage),
    );
    f.send({ kind: "done" });
    f.send({ kind: "complete" });
  }
  it("keeps request/proxy secrets off argv, makes no host HTTP calls and waits for durable stop", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy-user:proxy-secret@127.0.0.1:9999");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("NODE_OPTIONS", "must-not-reach-worker");
    const fetch = vi.spyOn(globalThis, "fetch"),
      f = fixture(),
      onEvent = vi.fn();
    const running = run(f, { execution: { onEvent } });
    await f.ready.promise;
    expect(f.payload()).toMatchObject({
      stream: true,
      proxy: "http://proxy-user:proxy-secret@127.0.0.1:9999",
      headers: { authorization: "Bearer fixture-secret" },
      body: { stream: true, stream_options: { include_usage: true } },
    });
    const command = f.launch.mock.calls[0][0];
    expect(command.args.join(" ")).not.toContain("fixture-secret");
    expect(command.args.join(" ")).not.toContain("proxy-secret");
    expect(command.environment?.NODE_OPTIONS).toBeUndefined();
    f.send(headers);
    f.send(chunk("Готово 🧪"));
    finish(f);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.proof.resolve(f.evidence);
    expect(await running).toMatchObject({
      outputText: "Готово 🧪",
      sessionId: "request",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: 0.01 },
    });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "stream:text" }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors explicit non-streaming with callbacks and preserves schema and provider headers", async () => {
    const f = fixture(),
      running = run(f, {
        stream: false,
        systemPrompt: "system",
        options: {
          ...input.options,
          headers: { "x-fixture": "value" },
          ...(provider === "openrouter"
            ? { effort: "high", httpReferer: "https://app.invalid", appTitle: "Fixture" }
            : {}),
        },
        execution: {
          onEvent: vi.fn(),
          systemPromptAppend: "append",
          outputSchema: { type: "object" },
        },
      });
    await f.ready.promise;
    expect(f.payload()).toMatchObject({
      stream: false,
      headers: { "x-fixture": "value" },
      body: {
        stream: false,
        messages: [
          { role: "system", content: "system\n\nappend" },
          { role: "user", content: input.prompt },
        ],
        response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } },
      },
    });
    if (provider === "openrouter")
      expect(f.payload()).toMatchObject({
        headers: { "http-referer": "https://app.invalid", "x-title": "Fixture" },
        body: { reasoning: { effort: "high" } },
      });
    f.send(headers);
    f.send(answer);
    f.send({ kind: "complete" });
    f.proof.resolve(f.evidence);
    expect(await running).toMatchObject({ outputText: "Готово 🧪", usage: { totalTokens: 5 } });
  });
  it.each([
    "missing_usage",
    "missing_done",
    "duplicate_headers",
    "foreign_id",
    "late_content",
    "repeat_usage",
    "nonzero",
    "unproven",
  ])("rejects false completion: %s", async (mode) => {
    const f = fixture(),
      running = run(f, { execution: { onEvent: vi.fn() } }),
      rejected = expect(running).rejects.toBeInstanceOf(Error);
    await f.ready.promise;
    f.send(headers);
    f.send(chunk("text"));
    if (mode === "duplicate_headers") f.send(headers);
    if (mode === "foreign_id")
      f.send({
        kind: "payload",
        payload: {
          id: "other",
          choices: [{ index: 0, delta: { content: "other" }, finish_reason: null }],
        },
      });
    f.send(chunk(null, "stop"));
    if (mode !== "missing_usage")
      f.send({ kind: "payload", payload: { id: "request", choices: [], usage: tokenUsage } });
    if (mode === "late_content") f.send(chunk("late"));
    if (mode === "repeat_usage")
      f.send({ kind: "payload", payload: { id: "request", choices: [], usage: tokenUsage } });
    if (mode !== "missing_done") f.send({ kind: "done" });
    f.send({ kind: "complete" });
    if (mode === "unproven") f.proof.reject(new Error("no native proof"));
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
          if (mode === "callback") throw new Error("callback failed");
        },
      },
    });
    const rejected = expect(running).rejects.toBeInstanceOf(Error);
    await f.ready.promise;
    if (mode !== "start") {
      f.send(headers);
      f.send(chunk("text"));
    }
    if (mode === "abort") abortController.abort();
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.child.stop).toHaveBeenCalled();
  });
  it.each([401, 429, 503])(
    "classifies HTTP %i without echoing a body or retrying",
    async (status) => {
      const f = fixture(),
        running = run(f),
        rejected = expect(running).rejects.toMatchObject({ httpStatus: status });
      await f.ready.promise;
      f.send({ ...headers, status });
      await rejected;
      expect(f.launch).toHaveBeenCalledOnce();
    },
  );
  it("rejects unsupported options/session/tool admission before reserving a native process", async () => {
    const f = fixture();
    for (const patch of [
      { sessionId: "old" },
      { resume: true },
      { model: "" },
      { options: { tools: [] } },
      { options: { apiRetryCount: 2 } },
      { execution: { environment: {} } },
      { execution: { hooks: {} } },
      { execution: { agentDefinitionName: "agent" } },
      { execution: { bypassPermissions: true } },
      { options: { ...input.options, headers: { host: "evil.invalid" } } },
    ])
      await expect(run(f, patch)).rejects.toMatchObject(
        provider === "codex"
          ? { cause: { adapterCode: "native_http_input_invalid" } }
          : { adapterCode: "native_http_input_invalid" },
      );
    await expect(run(f, { prompt: "x".repeat(1024 * 1024) })).rejects.toMatchObject(
      provider === "codex"
        ? { cause: { adapterCode: "native_http_input_limit" } }
        : { adapterCode: "native_http_input_limit" },
    );
    expect(f.launch).not.toHaveBeenCalled();
  });
});

describe("HTTP data protocol and external executor boundary", () => {
  it("accepts a text-only response with an explicitly empty tool list", () => {
    expect(
      parseNativeHttpFrame(
        JSON.stringify({
          ...answer,
          payload: {
            ...answer.payload,
            choices: [
              {
                index: 0,
                message: { content: "text", tool_calls: [], function_call: null, refusal: null },
                finish_reason: "stop",
              },
            ],
          },
        }),
        false,
      ),
    ).toMatchObject({ kind: "payload", text: "text", finish: true });
  });
  it.each([
    null,
    { kind: "stopped", activeProcesses: 0 },
    { kind: "payload", payload: { error: { message: "private" } } },
    { ...answer, payload: { ...answer.payload, usage: { prompt_tokens: -1 } } },
    {
      ...answer,
      payload: {
        ...answer.payload,
        usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
      },
    },
    {
      ...answer,
      payload: {
        ...answer.payload,
        choices: [{ index: 0, message: { tool_calls: [] }, finish_reason: "tool_calls" }],
      },
    },
    {
      ...answer,
      payload: {
        ...answer.payload,
        choices: [{ index: 0, message: { content: "partial" }, finish_reason: "length" }],
      },
    },
  ])("rejects untrusted or incomplete data %j", (frame) => {
    expect(() => parseNativeHttpFrame(JSON.stringify(frame), false)).toThrow();
  });
  it("rejects OpenCode run/resume and direct session creation before contacting the independent server", async () => {
    const f = fixture(),
      fetch = vi.spyOn(globalThis, "fetch"),
      adapter = createOpenCodeRuntimeAdapter({ logger });
    for (const operation of [
      adapter.run,
      createOpenCodeSession,
      runOpenCodeApi,
      (value: RuntimeRunInput) => adapter.resume!({ ...value, sessionId: "old" }),
    ])
      await expect(
        withNativeProcessScope<unknown>(root, f.launch, (scope) =>
          operation({ ...input, runtimeId: "opencode", execution: { nativeProcessScope: scope } }),
        ),
      ).rejects.toMatchObject({ adapterCode: "native_external_executor_unowned" });
    expect(fetch).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });
});
