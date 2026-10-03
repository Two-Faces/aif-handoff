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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { listenOnHighLoopbackPort } from "./fixtures/loopbackPort.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { resetEnvCache } from "@aif/shared";
import { UsageSource } from "@aif/runtime";
import { openCodeFixture } from "./fixtures/openCodeFixture.js";

const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const actualServer =
  await vi.importActual<typeof import("@aif/shared/server")>("@aif/shared/server");
const data = await import("@aif/data");
const { runTaskDeviceOpenCode, recoverTaskDeviceProcess } =
  await import("../services/deviceProcessSupervisor.js");
let root: string, database: string;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", undefined);
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("AIF_TEST_AMBIENT_TOKEN", "do-not-forward");
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

describe.skipIf(!["win32", "darwin"].includes(process.platform))(
  "owned OpenCode server and durable journal",
  () => {
    it.each([
      "success",
      "abort",
      "timeout",
      "callback",
      "server_exit",
      "wrong_session",
      "malformed",
      "overflow",
      "http_error",
      "wrong_version",
      "config_mismatch",
    ])(
      "runs %s and stops its detached writer",
      async (mode) => {
        const { task, workspace, input } = fixture(),
          cli = openCodeFixture(root, mode),
          abortController = new AbortController();
        let runId = "";
        const running = data.withTaskDeviceExecution(input, async () => {
          runId = data.currentTaskDeviceRunId()!;
          return runTaskDeviceOpenCode(task.id, {
            runtimeId: "opencode",
            transport: "api",
            cwd: workspace.worktreePath,
            model: "fixture",
            prompt: "private task",
            options: { opencodeCliPath: cli.path, modelBaseUrl: "http://127.0.0.1:1234/v1" },
            usageContext: { source: UsageSource.TEST, taskId: task.id, projectId: task.projectId },
            execution: {
              abortController,
              runTimeoutMs: mode === "timeout" ? 3500 : 12000,
              onEvent: (event) => {
                if (event.type === "system:init" && mode === "abort") abortController.abort();
                if (event.type === "stream:text" && mode === "callback")
                  throw new Error("callback");
              },
            },
          });
        });
        if (mode === "success") {
          expect(await running).toMatchObject({
            outputText: "Fixture done",
            sessionId: "ses_fixture",
            usage: null,
          });
          expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBeNull();
        } else {
          await expect(running).rejects.toBeInstanceOf(Error);
          await expect(running).rejects.not.toThrow("PRIVATE_UPSTREAM_BODY");
          if (mode === "http_error")
            await expect(running).rejects.toMatchObject({
              httpStatus: 503,
              adapterCode: "native_opencode_http_status",
            });
          expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBe(runId);
        }
        const journals = data.listTaskDeviceProcesses(runId);
        expect(journals).toHaveLength(1);
        expect(journals[0].state).toBe("stopped");
        expect(JSON.parse(journals[0].evidenceJson!).activeProcesses).toBe(0);
        const records = cli.records();
        expect(records.filter((r) => r.kind === "version")).toHaveLength(1);
        if (mode === "wrong_version") {
          expect(records.filter((r) => r.kind === "server")).toHaveLength(0);
          return;
        }
        const server = records.find((r) => r.kind === "server")!;
        expect(server.ppid).toBe(records[0].ppid);
        expect(server.pid).not.toBe(server.ppid);
        expect(server.hasAmbient).toBe(false);
        expect(server.auth).toBe(true);
        expect(server.projectDisabled).toBe("true");
        expect(
          records.filter((r) => r.kind === "request").every((r) => r.authorized === true),
        ).toBe(true);
        expect(existsSync(String(server.home))).toBe(false);
        const bytes = readFileSync(cli.marker).length;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(readFileSync(cli.marker).length).toBe(bytes);
      },
      20000,
    );
    it("recovers after coordinator death without releasing its run", async () => {
      const { task, workspace, input } = fixture(),
        cli = openCodeFixture(root, "crash");
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./fixtures/deviceProcessCrash.ts", import.meta.url)),
          database,
          task.id,
          input.projectRoot,
          workspace.worktreePath,
          cli.path,
          "opencode",
        ],
        {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          env: { ...process.env, AIF_PERSONAL_MODE: "false" },
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, stderr).toBe(86);
      const head = data.getTaskDeviceGrant(task.id)!,
        journal = data.listTaskDeviceProcesses(head.activeRunId!)[0];
      expect(journal.state).toBe("prepared");
      expect((await recoverTaskDeviceProcess(journal.id)).state).toBe("stopped");
      expect(data.getTaskDeviceGrant(task.id)).toEqual(head);
      const privateRoot = dirname(
        String(cli.records().find((record) => record.kind === "server")!.home),
      );
      expect(dirname(privateRoot)).toBe(realpathSync.native(tmpdir()));
      expect(basename(privateRoot)).toMatch(/^aif-opencode-/);
      rmSync(privateRoot, { recursive: true, force: true });
      const bytes = readFileSync(cli.marker).length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readFileSync(cli.marker).length).toBe(bytes);
      await expect(
        data.withTaskDeviceExecution(input, async () => undefined),
      ).rejects.toMatchObject({ code: "run_busy" });
    }, 20000);
    it("rejects mismatched scope and personal mode before creating processes", async () => {
      const { task, workspace, input } = fixture(),
        cli = openCodeFixture(root, "success");
      await data.withTaskDeviceExecution(input, async () => {
        const runId = data.currentTaskDeviceRunId()!;
        for (const bad of [{ cwd: root }, { runtimeId: "codex" }, { sessionId: "ses_old" }])
          await expect(
            runTaskDeviceOpenCode(task.id, {
              runtimeId: "opencode",
              transport: "api",
              cwd: workspace.worktreePath,
              model: "fixture",
              prompt: "task",
              options: { opencodeCliPath: cli.path, modelBaseUrl: "http://127.0.0.1:1234/v1" },
              usageContext: {
                source: UsageSource.TEST,
                taskId: task.id,
                projectId: task.projectId,
              },
              ...bad,
            }),
          ).rejects.toBeInstanceOf(Error);
        expect(data.listTaskDeviceProcesses(runId)).toEqual([]);
      });
      vi.stubEnv("AIF_PERSONAL_MODE", "true");
      resetEnvCache();
      await expect(
        data.withTaskDeviceExecution(input, async () => undefined),
      ).rejects.toBeInstanceOf(Error);
      expect(existsSync(cli.marker)).toBe(false);
    });
    it.skipIf(!process.env.OPENCODE_NATIVE_TEST_PATH)(
      "runs the installed OpenCode against a local model",
      async () => {
        const { task, workspace, input } = fixture();
        let requests = 0;
        const outputFile = join(workspace.worktreePath, "model-result.txt");
        const canary = join(root, "ambient-plugin-loaded.txt");
        writeFileSync(
          join(root, "ambient-plugin.mjs"),
          `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(canary)},'loaded');export default async()=>({});`,
        );
        writeFileSync(
          join(root, "ambient-config.json"),
          JSON.stringify({ plugin: [join(root, "ambient-plugin.mjs")] }),
        );
        vi.stubEnv("OPENCODE_CONFIG", join(root, "ambient-config.json"));
        const server = createServer(async (req, res) => {
          for await (const _chunk of req) {
            /* drain input */
          }
          requests++;
          res.writeHead(200, { "content-type": "text/event-stream" });
          if (requests === 1) {
            res.end(
              "data: " +
                JSON.stringify({
                  id: "fixture",
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_write",
                            type: "function",
                            function: {
                              name: "write",
                              arguments: JSON.stringify({
                                filePath: outputFile,
                                content: "written by real OpenCode",
                              }),
                            },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                }) +
                "\n\ndata: [DONE]\n\n",
            );
            return;
          }
          res.end(
            "data: " +
              JSON.stringify({
                id: "fixture",
                object: "chat.completion.chunk",
                created: 1,
                model: "fixture",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "Real OpenCode done" },
                    finish_reason: null,
                  },
                ],
              }) +
              "\n\ndata: " +
              JSON.stringify({
                id: "fixture",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
              }) +
              "\n\ndata: [DONE]\n\n",
          );
        });
        await listenOnHighLoopbackPort(server);
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture address");
        try {
          await data.withTaskDeviceExecution(input, async () => {
            const runId = data.currentTaskDeviceRunId()!;
            const result = await runTaskDeviceOpenCode(task.id, {
              runtimeId: "opencode",
              transport: "api",
              cwd: workspace.worktreePath,
              model: "fixture",
              prompt: "Say hello without tools",
              options: {
                opencodeCliPath: process.env.OPENCODE_NATIVE_TEST_PATH,
                modelBaseUrl: "http://127.0.0.1:" + address.port + "/v1",
              },
              usageContext: {
                source: UsageSource.TEST,
                taskId: task.id,
                projectId: task.projectId,
              },
              execution: { runTimeoutMs: 15000 },
            });
            expect(result.outputText).toBe("Real OpenCode done");
            expect(data.listTaskDeviceProcesses(runId)[0].state).toBe("stopped");
          });
          expect(requests).toBe(2);
          expect(readFileSync(outputFile, "utf8")).toBe("written by real OpenCode");
          expect(existsSync(canary)).toBe(false);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      25000,
    );
  },
);
