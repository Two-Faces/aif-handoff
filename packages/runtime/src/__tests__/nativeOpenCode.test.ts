import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedProcessIdentity, ProcessStopEvidence } from "@aif/shared";
import {
  withNativeProcessScope,
  type NativeProcessLaunchInput,
} from "../supervision/nativeProcessScope.js";
import type { SupervisedProcess } from "../supervision/processSupervisor.js";
import { UsageSource, type RuntimeRunInput } from "../types.js";
import { createOpenCodeRuntimeAdapter } from "../adapters/opencode/index.js";
import { createOpenCodeSession, runOpenCodeApi } from "../adapters/opencode/api.js";
import { parseNativeOpenCodeFrame } from "../adapters/opencode/nativeProtocol.js";
import { resolveOpenCodeExecutable } from "../adapters/opencode/native.js";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
let root: string;
const privateDirectories: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aif-opencode-unit-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "cli.mjs"), "// fixture");
});
afterEach(() => {
  for (const path of privateDirectories.splice(0)) {
    expect(path.startsWith(join(tmpdir(), "aif-opencode-"))).toBe(true);
    rmSync(path, { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function fixture() {
  const proof = deferred<ProcessStopEvidence>(),
    ready = deferred<void>(),
    id = randomUUID();
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
  const chunks: Buffer[] = [];
  const child: SupervisedProcess = {
    identity,
    completed: proof.promise,
    write: (b) => chunks.push(Buffer.from(b)),
    endInput: () => {
      privateDirectories.push(JSON.parse(Buffer.concat(chunks).toString()).directory);
      ready.resolve();
    },
    stop: vi.fn(async () => {
      proof.resolve(evidence);
      return proof.promise;
    }),
  };
  const launch = vi.fn(async (_input: NativeProcessLaunchInput) => child);
  const send = (frame: unknown) =>
    launch.mock.calls[0][0].onOutput?.("stdout", Buffer.from(JSON.stringify(frame) + "\n"));
  const input: RuntimeRunInput = {
    runtimeId: "opencode",
    transport: "api",
    model: "local-model",
    prompt: "private prompt",
    cwd: root,
    options: {
      opencodeCliPath: join(root, "cli.mjs"),
      modelBaseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "secret",
    },
    usageContext: { source: UsageSource.TEST },
    execution: { runTimeoutMs: 1000 },
  };
  const run = (overrides: Partial<RuntimeRunInput> = {}) =>
    withNativeProcessScope(root, launch, (scope) =>
      createOpenCodeRuntimeAdapter({ logger }).run({
        ...input,
        ...overrides,
        execution: { ...input.execution, ...overrides.execution, nativeProcessScope: scope },
      }),
    );
  return {
    proof,
    ready,
    child,
    evidence,
    launch,
    send,
    input,
    run,
    payload: () => JSON.parse(Buffer.concat(chunks).toString()),
  };
}
const payload = {
  info: {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    finish: "stop",
    time: { completed: 1 },
  },
  parts: [{ type: "text", sessionID: "ses_1", messageID: "msg_1", text: "done" }],
};
const frames = [
  { kind: "ready" },
  { kind: "session", id: "ses_1" },
  { kind: "result", payload },
  { kind: "complete" },
];
describe("owned OpenCode native protocol", () => {
  it("keeps secrets in stdin and returns only after native proof, then removes its private storage", async () => {
    vi.stubEnv("OPENCODE_SERVER_PASSWORD", "ambient");
    vi.stubEnv("NODE_OPTIONS", "ambient");
    const f = fixture(),
      done = vi.fn(),
      running = f.run().then((result) => {
        done();
        return result;
      });
    await f.ready.promise;
    const body = f.payload(),
      launch = f.launch.mock.calls[0][0];
    expect(launch.args.join(" ")).not.toContain("private prompt");
    expect(launch.args.join(" ")).not.toContain("secret");
    expect(body.environment.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(body.environment.NODE_OPTIONS).toBeUndefined();
    expect(body.expectedVersion).toBe("1.18.34");
    expect(existsSync(body.directory)).toBe(true);
    frames.forEach(f.send);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    f.proof.resolve(f.evidence);
    expect(await running).toMatchObject({ outputText: "done", sessionId: "ses_1", usage: null });
    expect(existsSync(body.directory)).toBe(false);
  });
  it.each([
    { baseUrl: "http://existing.invalid" },
    { serverPassword: "secret" },
    { opencodeArgs: ["serve"] },
    { unknown: true },
    { modelBaseUrl: "file:///tmp/model" },
    { modelBaseUrl: "http://user:password@localhost:1234" },
    { apiKey: "{file:secret}" },
    { contextWindow: 4096, maxOutputTokens: 4096 },
  ])("rejects unowned executors and unsupported settings before launch: %j", async (options) => {
    const f = fixture();
    await expect(f.run({ options: { ...f.input.options, ...options } })).rejects.toMatchObject({
      adapterCode:
        "baseUrl" in options || "serverPassword" in options
          ? "native_external_executor_unowned"
          : "native_opencode_input_invalid",
    });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it.each([
    { sessionId: "ses_old" },
    { resume: true },
    { transport: "cli" as const },
    { headers: {} },
    { execution: { hooks: {} } },
    { execution: { outputSchema: {} } },
    { execution: { environment: {} } },
    { execution: { bypassPermissions: true } },
  ])("rejects uncovered runtime input %j", async (overrides) => {
    const f = fixture();
    await expect(f.run(overrides)).rejects.toBeInstanceOf(Error);
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("keeps direct session creation and resume closed before HTTP", async () => {
    const f = fixture(),
      fetch = vi.spyOn(globalThis, "fetch");
    for (const op of [
      () => createOpenCodeSession(f.input),
      () => createOpenCodeRuntimeAdapter({ logger }).resume!({ ...f.input, sessionId: "ses_old" }),
    ]) {
      await withNativeProcessScope(root, f.launch, async (scope) => {
        f.input.execution!.nativeProcessScope = scope;
        await expect(op()).rejects.toMatchObject({
          adapterCode: "native_external_executor_unowned",
        });
      }).catch((error) => expect(error.adapterCode).toBe("native_launch_missing"));
    }
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it.each(["opencode.json", "opencode.jsonc", ".opencode"])(
    "rejects project configuration %s before launch",
    async (name) => {
      const f = fixture();
      writeFileSync(join(root, name), "{}");
      await expect(f.run()).rejects.toBeInstanceOf(Error);
      expect(f.launch).not.toHaveBeenCalled();
    },
  );
  it("resolves an explicit script fixture by files without starting it", () => {
    const path = join(root, "cli.mjs");
    expect(resolveOpenCodeExecutable(path)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("// fixture");
  });
  it("rejects ancestor configuration even above an intervening Git root", async () => {
    const f = fixture(),
      nested = join(root, "nested");
    mkdirSync(nested);
    mkdirSync(join(nested, ".git"));
    writeFileSync(join(root, "opencode.json"), "{}");
    await expect(f.run({ cwd: nested })).rejects.toMatchObject({
      adapterCode: "native_opencode_project_config_unsupported",
    });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it.each(
    [
      [{ kind: "complete" }],
      [frames[0], frames[0]],
      [frames[1]],
      [
        frames[0],
        frames[1],
        {
          kind: "result",
          payload: { ...payload, info: { ...payload.info, sessionID: "ses_other" } },
        },
      ],
      [...frames, { kind: "ready" }],
      frames.slice(0, 3),
      [frames[0], { kind: "error", code: "server_exit" }],
    ].map((received) => ({ received })),
  )("rejects incomplete or reordered frames and still joins stop", async ({ received }) => {
    const f = fixture(),
      running = f.run();
    void running.catch(() => undefined);
    await f.ready.promise;
    received.forEach(f.send);
    f.proof.resolve(f.evidence);
    await expect(running).rejects.toBeInstanceOf(Error);
    expect(f.child.stop).toHaveBeenCalled();
  });
  it("retains private storage when native stop cannot be proved", async () => {
    const f = fixture(),
      running = f.run();
    void running.catch(() => undefined);
    await f.ready.promise;
    frames.forEach(f.send);
    f.proof.reject(new Error("unproven stop"));
    await expect(running).rejects.toThrow("unproven stop");
    expect(existsSync(f.payload().directory)).toBe(true);
  });
  it("stops on callback failure without accepting completion", async () => {
    const f = fixture(),
      running = f.run({
        execution: {
          onEvent: () => {
            throw new Error("callback");
          },
        },
      });
    void running.catch(() => undefined);
    await f.ready.promise;
    f.send(frames[0]);
    await expect(running).rejects.toBeInstanceOf(Error);
    expect(f.child.stop).toHaveBeenCalled();
  });
  it.each([
    { ...payload, info: { ...payload.info, error: { name: "APIError" } } },
    { ...payload, info: { ...payload.info, finish: "length" } },
    { ...payload, info: { ...payload.info, time: {} } },
    { ...payload, parts: [{ ...payload.parts[0], sessionID: "ses_other" }] },
    {
      ...payload,
      parts: [
        { type: "tool", messageID: "msg_1", sessionID: "ses_1", state: { status: "running" } },
      ],
    },
  ])("rejects failed or cross-session result data", (value) =>
    expect(() =>
      parseNativeOpenCodeFrame(JSON.stringify({ kind: "result", payload: value })),
    ).toThrow(),
  );
  it("preserves HTTP errors without exposing response bodies", () => {
    expect(() =>
      parseNativeOpenCodeFrame(JSON.stringify({ kind: "error", code: "http_status", status: 429 })),
    ).toThrowError(expect.objectContaining({ httpStatus: 429, category: "rate_limit" }));
  });
  it("rejects raw malformed payload without quoting it", () =>
    expect(() => parseNativeOpenCodeFrame("PRIVATE_INPUT")).toThrow(
      "Native OpenCode attempt failed",
    ));
  it("honors the direct API entry's native admission before fetch", async () => {
    const f = fixture();
    await expect(
      withNativeProcessScope(root, f.launch, (scope) =>
        runOpenCodeApi({
          ...f.input,
          options: { baseUrl: "http://existing.invalid" },
          execution: { nativeProcessScope: scope },
        }),
      ),
    ).rejects.toMatchObject({ adapterCode: "native_external_executor_unowned" });
    expect(f.launch).not.toHaveBeenCalled();
  });
});
