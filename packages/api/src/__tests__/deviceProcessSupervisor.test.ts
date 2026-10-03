import { execFileSync, spawn } from "node:child_process";
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
import { resetEnvCache } from "@aif/shared";
import { UsageSource, type RuntimeRunInput } from "@aif/runtime";
const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const actualServer =
  await vi.importActual<typeof import("@aif/shared/server")>("@aif/shared/server");
const data = await import("@aif/data");
const { startTaskDeviceProcess, recoverTaskDeviceProcess, runTaskDeviceAppServer } =
  await import("../services/deviceProcessSupervisor.js");
let root: string, database: string;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-native-process-journal-")));
  database = join(root, "fixture.sqlite");
  if (db.current.$client.open) db.current.$client.close();
  db.current = actualServer.getDb(database) as ReturnType<typeof createTestDb>;
});
afterEach(() => {
  actualServer.closeDb();
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(root.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const projectRoot = join(root, "source");
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
    name: "Native process fixture",
    rootPath: projectRoot,
    personalMode: false,
  })!;
  const task = data.createTask({
    projectId: project.id,
    title: "fixture",
    description: "",
    paused: true,
    autoMode: false,
  })!;
  const workspace = data.prepareTaskExecutionWorkspace({
    taskId: task.id,
    projectId: project.id,
    projectRoot,
    worktreePath: join(root, "task"),
    snapshotCommit: git("rev-parse", "HEAD"),
  });
  data.initializeTaskDeviceGrant(task.id);
  return { task, workspace, input: { taskId: task.id, projectRoot } };
}
function appServerFixture(worktreePath: string, mode: "success" | "abort") {
  const marker = join(worktreePath, "native-writer.txt");
  const writer =
    "const fs=require('fs');setInterval(()=>fs.appendFileSync(" +
    JSON.stringify(marker) +
    ",'x'),10)";
  const header =
    "const fs=require('fs');require('child_process').spawn(process.execPath,['-e'," +
    JSON.stringify(writer) +
    "],{stdio:'ignore',detached:true}).unref();\n";
  let source = readFileSync(
    new URL(
      "../../../runtime/src/adapters/codex/appServer/__tests__/fixtures/fake-codex-app-server.mjs",
      import.meta.url,
    ),
    "utf8",
  )
    .replace("#!/usr/bin/env node", "")
    .replace('import readline from "node:readline";', 'const readline = require("node:readline");')
    .replace(
      'const scenario = process.env.FAKE_CODEX_SCENARIO ?? "run-success";',
      'const scenario = "run-success";',
    );
  source = source.replace(
    "function completeTurn(text, usage) {",
    "function completeTurn(text, usage) {\n" +
      "if(!fs.existsSync(" +
      JSON.stringify(marker) +
      ")){setTimeout(()=>completeTurn(text,usage),5);return;}\n" +
      (mode === "abort"
        ? 'sendNotification("item/agentMessage/delta",{threadId,turnId,itemId:"trigger",delta:"abort now"});return;\n'
        : ""),
  );
  // Node is the literal executable; its `app-server` argument loads this owned
  // fixture. The real protocol adapter and native host are not mocked.
  writeFileSync(join(worktreePath, "app-server"), header + source);
  return marker;
}
describe.skipIf(!["win32", "darwin"].includes(process.platform))(
  "native process and durable task journal bridge",
  () => {
    it("runs the real app-server adapter and persists native stop before returning its result", async () => {
      const { task, workspace, input } = fixture();
      const marker = appServerFixture(workspace.worktreePath, "success");
      let runId = "";
      await data.withTaskDeviceExecution(input, async () => {
        runId = data.currentTaskDeviceRunId()!;
        const result = await runTaskDeviceAppServer(task.id, {
          runtimeId: "codex",
          transport: "app-server",
          prompt: "fixture",
          cwd: workspace.worktreePath,
          options: { codexCliPath: process.execPath },
          usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
          execution: { runTimeoutMs: 10000 },
        });
        expect(result.outputText).toBe("Hello from fake app-server");
        const journals = data.listTaskDeviceProcesses(runId);
        expect(journals).toHaveLength(1);
        expect(journals[0].state).toBe("stopped");
        expect(JSON.parse(journals[0].evidenceJson!).activeProcesses).toBe(0);
        expect(existsSync(marker)).toBe(true);
        const length = readFileSync(marker).length;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(readFileSync(marker).length).toBe(length);
      });
      expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBeNull();
    }, 20000);
    it("retains the fenced run on cancellation even after the adapter unit and its writer stop", async () => {
      const { task, workspace, input } = fixture();
      const marker = appServerFixture(workspace.worktreePath, "abort");
      const abort = new AbortController();
      let runId = "";
      await expect(
        data.withTaskDeviceExecution(input, async () => {
          runId = data.currentTaskDeviceRunId()!;
          return runTaskDeviceAppServer(task.id, {
            runtimeId: "codex",
            transport: "app-server",
            prompt: "fixture",
            cwd: workspace.worktreePath,
            options: { codexCliPath: process.execPath },
            usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
            execution: {
              runTimeoutMs: 10000,
              abortController: abort,
              onEvent: (event) => {
                if (event.message === "abort now") abort.abort();
              },
            },
          });
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(abort.signal.aborted).toBe(true);
      const journals = data.listTaskDeviceProcesses(runId);
      expect(journals).toHaveLength(1);
      expect(journals[0].state).toBe("stopped");
      expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBe(runId);
      const length = readFileSync(marker).length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readFileSync(marker).length).toBe(length);
    }, 20000);
    it("rejects runtime scope substitutions before reserving or creating a process", async () => {
      const { task, workspace, input } = fixture();
      await expect(
        runTaskDeviceAppServer(task.id, {
          runtimeId: "codex",
          transport: "app-server",
          prompt: "fixture",
          cwd: workspace.worktreePath,
          usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
        }),
      ).rejects.toMatchObject({ code: "run_scope_required" });
      await data.withTaskDeviceExecution(input, async () => {
        const base: RuntimeRunInput = {
          runtimeId: "codex",
          transport: "app-server",
          prompt: "fixture",
          cwd: workspace.worktreePath,
          options: { codexCliPath: process.execPath },
          usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
        };
        for (const patch of [
          { runtimeId: "opencode" },
          { transport: "sdk" as const },
          { sessionId: "unbound-session", resume: true },
          { sourceSessionId: "unbound-fork" },
          { projectRoot: input.projectRoot },
          { usageContext: { ...base.usageContext, projectId: "foreign" } },
        ])
          await expect(
            runTaskDeviceAppServer(task.id, { ...base, ...patch }),
          ).rejects.toMatchObject({ adapterCode: "native_task_input_invalid" });
        vi.stubEnv("AIF_PERSONAL_MODE", "true");
        resetEnvCache();
        try {
          await expect(runTaskDeviceAppServer(task.id, base)).rejects.toMatchObject({
            code: "personal_execution_disabled",
          });
        } finally {
          vi.stubEnv("AIF_PERSONAL_MODE", "false");
          resetEnvCache();
        }
        expect(data.listTaskDeviceProcesses(data.currentTaskDeviceRunId()!)).toHaveLength(0);
      });
    });
    it("persists the native empty-job proof before settling the managed run", async () => {
      const { task, workspace, input } = fixture();
      let id = "";
      await data.withTaskDeviceExecution(input, async () => {
        await expect(
          startTaskDeviceProcess(task.id, {
            executable: process.execPath,
            args: ["-e", "process.exit(0)"],
            cwd: input.projectRoot,
          }),
        ).rejects.toMatchObject({ code: "run_root_mismatch" });
        expect(data.listTaskDeviceProcesses(data.currentTaskDeviceRunId()!)).toHaveLength(0);
        const child = await startTaskDeviceProcess(task.id, {
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: workspace.worktreePath,
        });
        id = child.journalId;
        expect(await child.completed).toMatchObject({ reason: "completed", activeProcesses: 0 });
        expect(data.getTaskDeviceProcess(id).state).toBe("stopped");
      });
      expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBeNull();
      const saved = data.getTaskDeviceProcess(id);
      expect(await recoverTaskDeviceProcess(id)).toEqual(saved);
    }, 20000);
    it("recovers from a new process after coordinator death without clearing its active grant/run", async () => {
      const { task, workspace, input } = fixture(),
        marker = join(workspace.worktreePath, "writer.txt");
      const host = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./fixtures/deviceProcessCrash.ts", import.meta.url)),
          database,
          task.id,
          input.projectRoot,
          workspace.worktreePath,
          marker,
        ],
        {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          env: { ...process.env, AIF_PERSONAL_MODE: "false" },
        },
      );
      let stderr = "";
      host.stderr.on("data", (bytes) => {
        stderr += bytes.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        host.once("error", reject);
        host.once("close", resolve);
      });
      expect(code, stderr).toBe(86);
      expect(existsSync(marker)).toBe(true);
      const head = data.getTaskDeviceGrant(task.id)!;
      const journal = data.listTaskDeviceProcesses(head.activeRunId!)[0];
      expect(journal.state).toBe("prepared");
      const recovered = await recoverTaskDeviceProcess(journal.id);
      expect(recovered.state).toBe("stopped");
      expect(JSON.parse(recovered.evidenceJson!).reason).toBe("recovered");
      expect(data.getTaskDeviceGrant(task.id)).toEqual(head);
      await expect(
        data.withTaskDeviceExecution(input, async () => undefined),
      ).rejects.toMatchObject({ code: "run_busy" });
    }, 20000);
  },
);
