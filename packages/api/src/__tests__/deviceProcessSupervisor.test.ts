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
import { claudeSdkFixture } from "./fixtures/claudeSdkFixture.js";
const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const actualServer =
  await vi.importActual<typeof import("@aif/shared/server")>("@aif/shared/server");
const data = await import("@aif/data");
const {
  startTaskDeviceProcess,
  recoverTaskDeviceProcess,
  runTaskDeviceAppServer,
  runTaskDeviceCli,
  runTaskDeviceSdk,
  runTaskDeviceClaudeSdk,
} = await import("../services/deviceProcessSupervisor.js");
let root: string, database: string;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", undefined);
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
function cliFixture(worktreePath: string, mode: "success" | "abort" | "timeout" | "malformed") {
  const marker = join(worktreePath, "native-cli-writer.txt"),
    promptPath = join(worktreePath, "prompt.txt");
  const writer =
    "const fs=require('fs');setInterval(()=>fs.appendFileSync(" +
    JSON.stringify(marker) +
    ",'x'),10)";
  // Node loads the default CLI's literal `exec` argument as this owned fixture.
  // Custom CLI argv and the native process layer are not mocked or bypassed.
  writeFileSync(
    join(worktreePath, "exec"),
    `
const fs = require('fs');
fs.writeFileSync('cli-launch.json', JSON.stringify({pid:process.pid, ppid:process.ppid, cwd:process.cwd(), argv:process.argv, origin:process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE}));
const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {stdio:'ignore',detached:true});
child.unref();
const input = [];
process.stdin.on('data', bytes => input.push(bytes));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(promptPath)}, Buffer.concat(input));
  function emit() {
    if (!fs.existsSync(${JSON.stringify(marker)})) { setTimeout(emit, 5); return; }
    process.stderr.write('CLI fixture stderr');
    if (${JSON.stringify(mode)} === 'malformed') { process.stdout.write('PRIVATE_FIXTURE_PARSE_ERROR\\n'); setInterval(() => {}, 1000); return; }
    const events = [
      {type:'thread.started', thread_id:'cli-native-thread'},
      {type:'item.completed', item:{id:'message-1', type:'agent_message', text:${JSON.stringify(mode === "abort" ? "abort now" : "CLI result 🧪")}}}
    ];
    if (${JSON.stringify(mode)} === 'success') events.push({type:'turn.completed', usage:{input_tokens:2, cached_input_tokens:0, output_tokens:3}});
    process.stdout.write(events.map(event => JSON.stringify(event)).join('\\n'), () => {
      if (${JSON.stringify(mode)} === 'success') process.exit(0);
      else { process.stdout.write('\\n'); setInterval(() => {}, 1000); }
    });
  }
  emit();
});
`,
  );
  return { marker, promptPath };
}
describe.skipIf(!["win32", "darwin"].includes(process.platform))(
  "native process and durable task journal bridge",
  () => {
    it.each([
      ["cli", "success", runTaskDeviceCli],
      ["cli", "abort", runTaskDeviceCli],
      ["cli", "timeout", runTaskDeviceCli],
      ["sdk", "success", runTaskDeviceSdk],
      ["sdk", "abort", runTaskDeviceSdk],
      ["sdk", "timeout", runTaskDeviceSdk],
    ] as const)(
      "runs %s through native stop and durable fencing: %s",
      async (transport, mode, run) => {
        const { task, workspace, input } = fixture();
        const { marker, promptPath } = cliFixture(workspace.worktreePath, mode);
        const prompt = "CLI fixture 🧪".repeat(6000),
          abort = new AbortController(),
          stderr: string[] = [];
        let runId = "";
        const running = data.withTaskDeviceExecution(input, async () => {
          runId = data.currentTaskDeviceRunId()!;
          const result = await run(task.id, {
            runtimeId: "codex",
            transport,
            prompt,
            cwd: workspace.worktreePath,
            options: { codexCliPath: process.execPath },
            usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
            execution: {
              runTimeoutMs: mode === "timeout" ? 2000 : 10000,
              abortController: abort,
              onEvent: (event) => {
                if (event.message === "abort now") abort.abort();
              },
              onStderr: (text) => stderr.push(text),
            },
          });
          expect(data.listTaskDeviceProcesses(runId)[0].state).toBe("stopped");
          return result;
        });
        if (mode === "success") {
          expect(await running).toMatchObject({
            outputText: "CLI result 🧪",
            usage: { totalTokens: 5 },
          });
          expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBeNull();
        } else {
          if (mode === "timeout")
            await expect(running).rejects.toMatchObject({ category: "timeout" });
          else await expect(running).rejects.toBeInstanceOf(Error);
          if (mode === "abort") expect(abort.signal.aborted).toBe(true);
          expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBe(runId);
        }
        const journals = data.listTaskDeviceProcesses(runId);
        expect(journals).toHaveLength(1);
        expect(journals[0].state).toBe("stopped");
        expect(JSON.parse(journals[0].evidenceJson!).activeProcesses).toBe(0);
        expect(readFileSync(promptPath, "utf8").endsWith(prompt)).toBe(true);
        expect(stderr.join("")).toBe(transport === "cli" ? "CLI fixture stderr" : "");
        if (transport === "sdk") {
          const launched = JSON.parse(
            readFileSync(join(workspace.worktreePath, "cli-launch.json"), "utf8"),
          );
          expect(launched).toMatchObject({
            origin: "codex_sdk_ts",
            cwd: workspace.worktreePath,
            ppid: JSON.parse(journals[0].preparedJson!).pid,
          });
          expect(launched.argv).toContain("--experimental-json");
          expect(launched.argv).toContain("--cd");
        }
        const length = readFileSync(marker).length;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(readFileSync(marker).length).toBe(length);
      },
      20000,
    );
    it("stops the real SDK worker and descendants after malformed CLI output without leaking it", async () => {
      const { task, workspace, input } = fixture();
      const { marker } = cliFixture(workspace.worktreePath, "malformed");
      let runId = "";
      const running = data.withTaskDeviceExecution(input, () => {
        runId = data.currentTaskDeviceRunId()!;
        return runTaskDeviceSdk(task.id, {
          runtimeId: "codex",
          transport: "sdk",
          prompt: "fixture",
          cwd: workspace.worktreePath,
          options: { codexCliPath: process.execPath },
          usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
          execution: { runTimeoutMs: 10000 },
        });
      });
      await expect(running).rejects.toMatchObject({
        cause: { adapterCode: "native_sdk_worker_failed" },
      });
      await expect(running).rejects.not.toThrow("PRIVATE_FIXTURE_PARSE_ERROR");
      expect(data.listTaskDeviceProcesses(runId)[0].state).toBe("stopped");
      expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBe(runId);
      const length = readFileSync(marker).length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readFileSync(marker).length).toBe(length);
    }, 20000);
    it.each(["success", "abort", "timeout", "malformed", "old_version", "nonzero"] as const)(
      "supervises the actual Claude SDK and its CLI through %s",
      async (mode) => {
        const { task, workspace, input } = fixture();
        const { path, marker } = claudeSdkFixture(workspace.worktreePath, mode);
        const abortController = new AbortController(),
          onToolUse = vi.fn(),
          onSubagentStart = vi.fn();
        let runId = "";
        const running = data.withTaskDeviceExecution(input, async () => {
          runId = data.currentTaskDeviceRunId()!;
          const result = await runTaskDeviceClaudeSdk(task.id, {
            runtimeId: "claude",
            providerId: "anthropic",
            transport: "sdk",
            prompt: "Claude задача 🧪",
            cwd: workspace.worktreePath,
            options: { claudeCliPath: path },
            usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
            execution: {
              runTimeoutMs: mode === "timeout" ? 3000 : 10000,
              abortController,
              onToolUse,
              onSubagentStart,
              onEvent: (event) => {
                if (mode === "abort" && event.type === "stream:text") abortController.abort();
              },
            },
          });
          expect(data.listTaskDeviceProcesses(runId)[0].state).toBe("stopped");
          return result;
        });
        if (mode === "success") {
          expect(await running).toMatchObject({
            outputText: "Claude result 🧪",
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: 0.01 },
          });
          expect(onToolUse).toHaveBeenCalledWith("Bash", " `fixture`");
          expect(onSubagentStart).toHaveBeenCalledWith("reviewer", "agent");
          expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBeNull();
        } else {
          await expect(running).rejects.toBeInstanceOf(Error);
          if (mode === "malformed") {
            await expect(running).rejects.toMatchObject({
              adapterCode: "native_claude_worker_failed",
            });
            await expect(running).rejects.not.toThrow("PRIVATE_CLAUDE_PARSE_ERROR");
          }
          if (mode === "old_version")
            await expect(running).rejects.toMatchObject({
              adapterCode: "native_claude_version_unsupported",
            });
          if (mode === "abort") expect(abortController.signal.aborted).toBe(true);
          expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBe(runId);
        }
        const journals = data.listTaskDeviceProcesses(runId);
        expect(journals).toHaveLength(1);
        expect(journals[0].state).toBe("stopped");
        const workerPid = JSON.parse(journals[0].preparedJson!).pid;
        expect(
          JSON.parse(readFileSync(join(workspace.worktreePath, "claude-version.json"), "utf8")),
        ).toMatchObject({ ppid: workerPid, cwd: workspace.worktreePath });
        if (mode === "old_version") {
          expect(existsSync(marker)).toBe(false);
          return;
        }
        const launched = JSON.parse(
          readFileSync(join(workspace.worktreePath, "claude-launch.json"), "utf8"),
        );
        expect(launched).toMatchObject({ ppid: workerPid, cwd: workspace.worktreePath });
        expect(launched.argv).toContain("--setting-sources=");
        expect(launched.argv).toContain("--strict-mcp-config");
        expect(launched.argv).toContain("--no-session-persistence");
        const length = readFileSync(marker).length;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(readFileSync(marker).length).toBe(length);
      },
      20000,
    );
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
    it.each([
      ["codex", "app-server", runTaskDeviceAppServer],
      ["codex", "cli", runTaskDeviceCli],
      ["codex", "sdk", runTaskDeviceSdk],
      ["claude", "sdk", runTaskDeviceClaudeSdk],
    ] as const)(
      "rejects %s/%s scope substitutions before reserving or creating a process",
      async (runtimeId, transport, run) => {
        const { task, workspace, input } = fixture();
        await expect(
          run(task.id, {
            runtimeId,
            transport,
            prompt: "fixture",
            cwd: workspace.worktreePath,
            usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
          }),
        ).rejects.toMatchObject({ code: "run_scope_required" });
        await data.withTaskDeviceExecution(input, async () => {
          const base: RuntimeRunInput = {
            runtimeId,
            transport,
            prompt: "fixture",
            cwd: workspace.worktreePath,
            options: { codexCliPath: process.execPath },
            usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
          };
          for (const patch of [
            { runtimeId: "opencode" },
            { transport: "api" as const },
            { sessionId: "unbound-session", resume: true },
            { sourceSessionId: "unbound-fork" },
            { projectRoot: input.projectRoot },
            { usageContext: { ...base.usageContext, projectId: "foreign" } },
          ])
            await expect(run(task.id, { ...base, ...patch })).rejects.toMatchObject({
              adapterCode: "native_task_input_invalid",
            });
          if (transport === "cli" || transport === "sdk")
            await expect(
              run(task.id, { ...base, options: { codexCliArgs: ["exec", "resume", "--last"] } }),
            ).rejects.toMatchObject({ adapterCode: "native_task_input_invalid" });
          if (transport === "sdk")
            for (const patch of [
              { options: { codexConfig: {} } },
              { execution: { outputSchema: {} } },
              { execution: { hooks: {} } },
              { execution: { environment: {} } },
            ])
              await expect(run(task.id, { ...base, ...patch })).rejects.toMatchObject({
                adapterCode: "native_task_input_invalid",
              });
          vi.stubEnv("AIF_PERSONAL_MODE", "true");
          resetEnvCache();
          try {
            await expect(run(task.id, base)).rejects.toMatchObject({
              code: "personal_execution_disabled",
            });
          } finally {
            vi.stubEnv("AIF_PERSONAL_MODE", "false");
            resetEnvCache();
          }
          expect(data.listTaskDeviceProcesses(data.currentTaskDeviceRunId()!)).toHaveLength(0);
        });
      },
    );
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
    it.each(["raw", "sdk", "claude"] as const)(
      "recovers %s from a new process after coordinator death without clearing its active grant/run",
      async (mode) => {
        const { task, workspace, input } = fixture(),
          marker =
            mode === "claude"
              ? claudeSdkFixture(workspace.worktreePath, "timeout").marker
              : mode === "sdk"
                ? cliFixture(workspace.worktreePath, "timeout").marker
                : join(workspace.worktreePath, "writer.txt");
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
            mode,
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
      },
      20000,
    );
  },
);
