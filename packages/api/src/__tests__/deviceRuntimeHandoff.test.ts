import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { resetEnvCache, continuationNotesSchema } from "@aif/shared";
import { UsageSource, type RuntimeRunInput } from "@aif/runtime";
import { claudeSdkFixture } from "./fixtures/claudeSdkFixture.js";
import { openCodeFixture } from "./fixtures/openCodeFixture.js";
import { httpCompletionFixture } from "./fixtures/httpCompletionFixture.js";

const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const actualServer =
  await vi.importActual<typeof import("@aif/shared/server")>("@aif/shared/server");
const data = await import("@aif/data");
const { executeTaskDeviceIsolatedRuntime } = await import("../services/deviceIsolatedRuntime.js");
const { checkpointNativeTaskHandoff } = await import("../services/deviceHandoff.js");
const { recoverTaskDeviceProcess } = await import("../services/deviceProcessSupervisor.js");
let directory: string, database: string, taskId: string | undefined;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  vi.stubEnv("NO_PROXY", "*");
  resetEnvCache();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-runtime-handoff-")));
  database = join(directory, "fixture.sqlite");
  if (db.current.$client.open) db.current.$client.close();
  db.current = actualServer.getDb(database) as ReturnType<typeof createTestDb>;
  taskId = undefined;
});
afterEach(async () => {
  const runId = taskId && data.getTaskDeviceGrant(taskId)?.activeRunId;
  if (runId)
    for (const process of data.listTaskDeviceProcesses(runId)) {
      if (process.identityJson && process.state !== "stopped")
        await recoverTaskDeviceProcess(process.id);
    }
  actualServer.closeDb();
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const projectRoot = join(directory, "source");
  mkdirSync(projectRoot);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(projectRoot, "code.txt"), "base\n");
  git("add", "code.txt");
  git("-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const project = data.createProject({
    name: "Runtime handoff",
    rootPath: projectRoot,
    personalMode: false,
  })!;
  const task = data.createTask({
    projectId: project.id,
    title: "Test",
    description: "",
    paused: true,
    autoMode: false,
  })!;
  taskId = task.id;
  const workspace = data.prepareTaskExecutionWorkspace({
    taskId: task.id,
    projectId: project.id,
    projectRoot,
    worktreePath: join(directory, "task"),
    snapshotCommit: git("rev-parse", "HEAD"),
  });
  const grant = data.initializeTaskDeviceGrant(task.id);
  const targetDeviceId = randomUUID();
  data.registerSyncPeer({
    deviceId: targetDeviceId,
    name: "Target",
    fingerprint: "b".repeat(64),
    projectIds: [project.id],
  });
  const request = {
    id: randomUUID(),
    taskId: task.id,
    expectedGrantId: grant.grantId,
    targetDeviceId,
    notes: continuationNotesSchema.parse({ goal: "Continue", nextStep: "Review" }),
  };
  const input: RuntimeRunInput = {
    runtimeId: "opencode",
    transport: "api",
    prompt: "offline fixture",
    model: "fixture/model",
    cwd: workspace.worktreePath,
    usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: project.id },
  };
  return { task, workspace, request, input, git };
}

describe.skipIf(!["win32", "darwin"].includes(process.platform))(
  "isolated runtime checkpoint and release",
  () => {
    it.each([
      ["claude", "sdk"],
      ["claude", "api"],
      ["claude", "cli"],
      ["codex", "api"],
      ["openrouter", "api"],
      ["opencode", "api"],
    ] as const)(
      "checkpoints an admitted %s/%s invocation after durable native stop",
      async (runtimeId, transport) => {
        const f = fixture();
        const input: RuntimeRunInput = { ...f.input, runtimeId, transport };
        let http: Awaited<ReturnType<typeof httpCompletionFixture>> | undefined;
        if (runtimeId === "claude")
          input.options = {
            claudeCliPath: claudeSdkFixture(
              f.workspace.worktreePath,
              "success",
              transport as "sdk" | "api" | "cli",
            ).path,
            apiKey: "fixture-secret",
            baseUrl: "http://127.0.0.1:1",
          };
        else if (runtimeId === "opencode")
          input.options = {
            opencodeCliPath: openCodeFixture(f.workspace.worktreePath, "success").path,
            modelBaseUrl: "http://127.0.0.1:1/v1",
          };
        else {
          http = await httpCompletionFixture("json", runtimeId);
          input.options = { apiKey: "fixture-secret", baseUrl: http.url };
        }
        try {
          const result = await executeTaskDeviceIsolatedRuntime(f.task.id, input);
          expect(result.outputText).toBeTruthy();
          expect(data.getTaskDeviceGrant(f.task.id)!.activeRunId).toBeNull();
          data.requestTaskDeviceHandoff(f.request);
          const checkpoint = await checkpointNativeTaskHandoff(f.request.id);
          expect(checkpoint.phase).toBe("checkpointed");
          expect(await checkpointNativeTaskHandoff(f.request.id)).toEqual(checkpoint);
          const pack = data.loadCodeSnapshotPackage(checkpoint.snapshotId!, f.task.projectId!);
          expect(pack.descriptor.taskId).toBe(f.task.id);
          const offer = data.releaseTaskDeviceHandoff(f.request.id);
          expect(offer.grant.snapshotId).toBe(pack.id);
          expect(data.getTaskDeviceGrant(f.task.id)).toMatchObject({
            state: "observed",
            ownerDeviceId: f.request.targetDeviceId,
            activeRunId: null,
          });
          expect(f.git("rev-parse", "HEAD")).toBe(f.workspace.snapshotCommit);
        } finally {
          await http?.close();
        }
      },
      30000,
    );

    it("rejects uncontained callbacks, Codex process transports and foreign roots before reserving a run", async () => {
      const f = fixture();
      for (const patch of [
        { execution: { onEvent: () => undefined } },
        { execution: { hooks: {} } },
        { execution: { environment: {} } },
        { sessionId: "old" },
        { resume: true },
        { runtimeId: "codex", transport: "cli" },
        { runtimeId: "external", transport: "api" },
        { cwd: directory },
        { options: { function: () => undefined } },
      ] as Partial<RuntimeRunInput>[]) {
        await expect(
          Promise.resolve().then(() =>
            executeTaskDeviceIsolatedRuntime(f.task.id, { ...f.input, ...patch }),
          ),
        ).rejects.toMatchObject({ adapterCode: "native_run_admission_invalid" });
        expect(data.getTaskDeviceGrant(f.task.id)!.activeRunId).toBeNull();
      }
      vi.stubEnv("AIF_PERSONAL_MODE", "true");
      resetEnvCache();
      await expect(executeTaskDeviceIsolatedRuntime(f.task.id, f.input)).rejects.toMatchObject({
        code: "personal_execution_disabled",
      });
    });

    it("recovers a live owned server after coordinator death before freezing its files and releasing authority", async () => {
      const f = fixture();
      const native = openCodeFixture(f.workspace.worktreePath, "crash");
      const input = {
        ...f.input,
        options: { opencodeCliPath: native.path, modelBaseUrl: "http://127.0.0.1:1/v1" },
      };
      const worker = fileURLToPath(
        new URL("./fixtures/isolatedRuntimeCoordinator.ts", import.meta.url),
      );
      const inputFile = join(directory, "input.json");
      writeFileSync(inputFile, JSON.stringify(input));
      const child = spawn(process.execPath, ["--import", "tsx", worker, f.task.id, inputFile], {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          DATABASE_URL: database,
          AIF_PERSONAL_MODE: "false",
          LOG_LEVEL: "fatal",
        },
      });
      const exited = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
      try {
        await vi.waitFor(() => expect(existsSync(native.marker)).toBe(true), {
          timeout: 15000,
          interval: 20,
        });
        const grant = data.getTaskDeviceGrant(f.task.id)!;
        const receipt = data.listTaskDeviceProcesses(grant.activeRunId!)[0];
        expect(receipt.state).toBe("prepared");
        child.kill("SIGKILL");
        await exited;
        data.requestTaskDeviceHandoff(f.request);
        const checkpoint = await checkpointNativeTaskHandoff(f.request.id);
        expect(data.getTaskDeviceProcess(receipt.id).state).toBe("stopped");
        expect(data.getTaskDeviceGrant(f.task.id)!.activeRunId).toBe(grant.activeRunId);
        const bytes = readFileSync(native.marker);
        expect(checkpoint.snapshotId).toBeTruthy();
        data.releaseTaskDeviceHandoff(f.request.id);
        expect(readFileSync(native.marker)).toEqual(bytes);
        expect(data.getTaskDeviceGrant(f.task.id)).toMatchObject({
          state: "observed",
          activeRunId: null,
        });
        expect(data.getTaskDeviceRun(grant.activeRunId!)!.state).toBe("uncertain");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    }, 30000);
  },
);
