import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNativeProcessMode,
  launchNativeStdioProcess,
  resolveNativeExecutable,
  nativeProcessEnvironment,
  withNativeProcessScope,
  type NativeProcessScope,
  type NativeProcessLaunchInput,
} from "../supervision/nativeProcessScope.js";
import type { SupervisedProcess } from "../supervision/processSupervisor.js";
import type { ProcessStopEvidence } from "@aif/shared";
import { createClaudeRuntimeAdapter } from "../adapters/claude/index.js";
import { createCodexRuntimeAdapter } from "../adapters/codex/index.js";
import { createOpenCodeRuntimeAdapter } from "../adapters/opencode/index.js";
import { createOpenRouterRuntimeAdapter } from "../adapters/openrouter/index.js";
import { spawnCodexAppServerProcess } from "../adapters/codex/appServer/process.js";
import { UsageSource, type RuntimeRunInput } from "../types.js";
import { createRuntimeRegistry } from "../registry.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function fixture(manual = false) {
  const id = randomUUID(),
    stopped = deferred<ProcessStopEvidence>();
  const evidence: ProcessStopEvidence = {
    identity: {
      version: 1,
      mechanism: "windows_job_v1",
      id,
      jobName: "Local\\AifHandoff-" + id,
      hostPid: 11,
      hostBirth: "100",
      hostSessionId: 1,
      pid: 12,
      birth: "200",
    },
    activeProcesses: 0,
    reason: "cancelled",
    exitCode: 0,
    terminatedProcesses: 0,
  };
  const child: SupervisedProcess = {
    identity: { ...evidence.identity, pid: 12, birth: "200" } as SupervisedProcess["identity"],
    completed: stopped.promise,
    stop: vi.fn(async () => {
      if (!manual) stopped.resolve(evidence);
      return stopped.promise;
    }),
    write: vi.fn(),
    endInput: vi.fn(),
  };
  const launch = vi.fn(async (_input: NativeProcessLaunchInput) => child);
  return { launch, child, stopped, evidence };
}
const root = resolve("native-task-scope");
const command = { executable: process.execPath, args: [], cwd: root };
const input: RuntimeRunInput = {
  runtimeId: "codex",
  transport: "app-server",
  prompt: "fixture",
  cwd: root,
  projectRoot: root,
  usageContext: { source: UsageSource.TEST },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("host-owned native runtime scope", () => {
  it("adds Windows OS essentials without leaking auth or overriding explicit case-insensitive values", () => {
    vi.stubEnv("SYSTEMROOT", "C:\\Windows");
    vi.stubEnv("OPENAI_API_KEY", "must-not-be-forwarded");
    vi.stubEnv("NODE_OPTIONS", "must-not-be-forwarded");
    const input = { Path: "explicit-path", SystemDrive: "D:" };
    const env = nativeProcessEnvironment(input, "win32");
    expect(Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1]).toBe(
      "C:\\Windows",
    );
    expect(env.Path).toBe("explicit-path");
    expect(env.PATH).toBeUndefined();
    expect(env.SystemDrive).toBe("D:");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(input).toEqual({ Path: "explicit-path", SystemDrive: "D:" });
    expect(nativeProcessEnvironment({}, "darwin")).toEqual({});
  });
  it("holds a successful adapter result until native stop acknowledgement and closes the capability", async () => {
    const f = fixture(true);
    let scope!: NativeProcessScope,
      resultReturned = false;
    const running = withNativeProcessScope(root, f.launch, async (token) => {
      scope = token;
      await launchNativeStdioProcess(token, command);
      return "result";
    }).then((result) => {
      resultReturned = true;
      return result;
    });
    await vi.waitFor(() => expect(f.child.stop).toHaveBeenCalled());
    expect(resultReturned).toBe(false);
    f.stopped.resolve(f.evidence);
    expect(await running).toBe("result");
    await expect(launchNativeStdioProcess(scope, command)).rejects.toMatchObject({
      adapterCode: "native_scope_invalid",
    });
  });
  it("does not return success when native stop cannot be proved", async () => {
    const f = fixture(true);
    const running = withNativeProcessScope(root, f.launch, async (scope) => {
      await launchNativeStdioProcess(scope, command);
      return "unproven";
    });
    const rejected = expect(running).rejects.toThrow("stop unproven");
    await vi.waitFor(() => expect(f.child.stop).toHaveBeenCalled());
    f.stopped.reject(new Error("stop unproven"));
    await rejected;
  });
  it("awaits native cleanup after the adapter throws and does not replace that failure with success", async () => {
    const f = fixture();
    await expect(
      withNativeProcessScope(root, f.launch, async (scope) => {
        await launchNativeStdioProcess(scope, command);
        throw new Error("adapter failed");
      }),
    ).rejects.toThrow("adapter failed");
    expect(f.child.stop).toHaveBeenCalled();
    expect(f.launch.mock.calls[0][0].signal?.aborted).toBe(true);
  });
  it("cancels and joins a pending launch even when the adapter forgot to await it", async () => {
    const f = fixture(true),
      launched = deferred<SupervisedProcess>();
    f.launch.mockImplementation(() => launched.promise);
    let returned = false;
    const running = withNativeProcessScope(root, f.launch, async (scope) => {
      void launchNativeStdioProcess(scope, command);
      await expect(launchNativeStdioProcess(scope, command)).rejects.toMatchObject({
        adapterCode: "native_scope_conflict",
      });
      return "result";
    }).then((value) => {
      returned = true;
      return value;
    });
    await vi.waitFor(() => expect(f.launch.mock.calls[0][0].signal?.aborted).toBe(true));
    expect(returned).toBe(false);
    launched.resolve(f.child);
    await vi.waitFor(() => expect(f.child.stop).toHaveBeenCalled());
    expect(returned).toBe(false);
    f.stopped.resolve(f.evidence);
    expect(await running).toBe("result");
    expect(f.launch).toHaveBeenCalledOnce();
  });
  it("rejects ignored, forged, reused and wrong-root scopes before another launch", async () => {
    const f = fixture();
    expect(() =>
      assertNativeProcessMode(
        { ...input, execution: { nativeProcessScope: { nativeProcessScope: true } } },
        true,
      ),
    ).toThrow(expect.objectContaining({ adapterCode: "native_scope_invalid" }));
    await expect(
      withNativeProcessScope(root, f.launch, async () => "ignored"),
    ).rejects.toMatchObject({ adapterCode: "native_launch_missing" });
    await withNativeProcessScope(root, f.launch, async (scope) => {
      await expect(
        launchNativeStdioProcess(scope, { ...command, cwd: dirname(root) }),
      ).rejects.toMatchObject({ adapterCode: "native_scope_conflict" });
      await launchNativeStdioProcess(scope, command);
      await expect(launchNativeStdioProcess(scope, command)).rejects.toMatchObject({
        adapterCode: "native_scope_conflict",
      });
      expect(() =>
        spawnCodexAppServerProcess({ input: { runtimeId: "codex", nativeProcessScope: scope } }),
      ).toThrow(expect.objectContaining({ adapterCode: "native_scope_required" }));
    });
    expect(f.launch).toHaveBeenCalledOnce();
  });
  it("buffers early output, chunks stdin, forwards EOF and emits exit only after proof", async () => {
    const f = fixture(true);
    f.launch.mockImplementation(async (launch) => {
      launch.onOutput?.("stdout", Buffer.from("early"));
      return f.child;
    });
    await withNativeProcessScope(root, f.launch, async (scope) => {
      const child = await launchNativeStdioProcess(scope, command);
      const output: Buffer[] = [];
      child.stdout.on("data", (bytes) => output.push(bytes));
      const exit = vi.fn();
      child.on("exit", exit);
      const bytes = Buffer.alloc(150000, 42);
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())),
      );
      expect(vi.mocked(f.child.write).mock.calls.map(([part]) => part.length)).toEqual([
        65536, 65536, 18928,
      ]);
      child.stdin.end();
      expect(f.child.endInput).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      f.stopped.resolve(f.evidence);
      await child.stop();
      expect(exit).toHaveBeenCalledWith(0, null);
      expect(Buffer.concat(output).toString()).toBe("early");
    });
  });
  it("bounds unread output and requests native stop instead of adopting truncated output", async () => {
    const f = fixture();
    await expect(
      withNativeProcessScope(root, f.launch, async (scope) => {
        const child = await launchNativeStdioProcess(scope, command);
        f.launch.mock.calls[0][0].onOutput?.("stdout", Buffer.alloc(4 * 1024 * 1024 + 1));
        expect(child.kill()).toBe(false);
      }),
    ).rejects.toMatchObject({ adapterCode: "native_output_overflow" });
    expect(f.child.stop).toHaveBeenCalled();
  });
  it("drains buffered stdio even when native completion predates the batch consumer", async () => {
    const f = fixture();
    f.launch.mockImplementation(async (input) => {
      input.onOutput?.("stdout", Buffer.from("completed before attach"));
      input.onOutput?.("stderr", Buffer.from("diagnostic"));
      f.stopped.resolve(f.evidence);
      return f.child;
    });
    await withNativeProcessScope(root, f.launch, async (scope) => {
      const child = await launchNativeStdioProcess(scope, command);
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      expect(await child.waitForExit()).toBe(0);
      expect(Buffer.concat(stdout).toString()).toBe("completed before attach");
      expect(Buffer.concat(stderr).toString()).toBe("diagnostic");
    });
  });
  it("resolves literal PATH executables and rejects relative paths and shell wrappers", () => {
    expect(
      resolveNativeExecutable(basename(process.execPath), { PATH: dirname(process.execPath) }),
    ).toBe(resolveNativeExecutable(process.execPath, {}));
    for (const candidate of ["./node", "missing-runtime", join(root, "missing.exe")])
      expect(() => resolveNativeExecutable(candidate, { PATH: "relative-entry" })).toThrow();
    if (process.platform === "win32")
      expect(() => resolveNativeExecutable("C:\\tools\\codex.cmd", {})).toThrow();
  });
  it("does not start uncontained model discovery before a scoped adapter run", async () => {
    const f = fixture(),
      adapter = createCodexRuntimeAdapter();
    const listModels = vi.fn(async () => []);
    const run = vi.fn(async (value: RuntimeRunInput) => {
      await launchNativeStdioProcess(value.execution!.nativeProcessScope!, command);
      return { outputText: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    });
    const registry = createRuntimeRegistry({
      builtInAdapters: [{ ...adapter, run, listModels }],
      modelEffortDiscoveryEnabled: true,
    });
    await withNativeProcessScope(root, f.launch, (scope) =>
      registry.resolveRuntime("codex").run({
        ...input,
        model: "gpt-5.4",
        options: { modelReasoningEffort: "high" },
        execution: { nativeProcessScope: scope },
      }),
    );
    expect(run).toHaveBeenCalledOnce();
    expect(listModels).not.toHaveBeenCalled();
  });
  it.each([
    ["claude", "app-server", createClaudeRuntimeAdapter],
    ["codex", "api", createCodexRuntimeAdapter],
    ["openrouter", "api", createOpenRouterRuntimeAdapter],
    ["opencode", "api", createOpenCodeRuntimeAdapter],
  ] as const)(
    "rejects unsupported %s/%s without native launch or HTTP",
    async (runtimeId, transport, factory) => {
      const f = fixture(),
        fetch = vi.spyOn(globalThis, "fetch");
      const adapter = factory();
      await expect(
        withNativeProcessScope(root, f.launch, (scope) =>
          adapter.run({
            ...input,
            runtimeId,
            transport,
            execution: { nativeProcessScope: scope },
          }),
        ),
      ).rejects.toMatchObject({ category: "transport" });
      expect(f.launch).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      if (adapter.resume)
        await expect(
          withNativeProcessScope(root, f.launch, (scope) =>
            adapter.resume!({
              ...input,
              runtimeId,
              transport,
              sessionId: "unbound",
              execution: { nativeProcessScope: scope },
            }),
          ),
        ).rejects.toMatchObject({ category: "transport" });
      if (adapter.forkSession)
        await expect(
          withNativeProcessScope(root, f.launch, (scope) =>
            adapter.forkSession!({
              ...input,
              runtimeId,
              transport,
              sourceSessionId: "unbound",
              execution: { nativeProcessScope: scope },
            }),
          ),
        ).rejects.toMatchObject({ category: "transport" });
      expect(f.launch).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
