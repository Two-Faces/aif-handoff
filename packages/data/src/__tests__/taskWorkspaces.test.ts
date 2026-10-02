import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import {
  tasks,
  resetEnvCache,
  PersonalExecutionDisabledError,
  prepareTaskCheckout,
} from "@aif/shared";
import { eq } from "drizzle-orm";

const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const data = await import("../index.js");
const TIMEOUT = 30_000;
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const worker = fileURLToPath(new URL("fixtures/workspaceRecovery.ts", import.meta.url));
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}
let directory: string;
let source: string;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  db.current.$client.close();
  db.current = createTestDb();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-workspace-journal-")));
  source = join(directory, "source");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Recovery Test");
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "config", "core.autocrlf", "false");
  git(source, "config", "commit.gpgsign", "false");
  writeFileSync(join(source, "task.txt"), "base\n");
  git(source, "add", "task.txt");
  git(source, "commit", "-m", "base");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
function seed(personalMode = false) {
  const project = data.createProject({ name: "Task workspace", rootPath: source, personalMode });
  if (!project) throw new Error("Missing project");
  const task = data.createTask({
    projectId: project.id,
    title: "Task",
    description: "",
    paused: true,
    autoMode: false,
  })!;
  return {
    projectRoot: source,
    worktreePath: join(directory, "task"),
    projectId: project.id,
    taskId: task.id,
    snapshotCommit: git(source, "rev-parse", "HEAD"),
  };
}
function runWorker(mode: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", worker, mode, directory], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      DATABASE_URL: join(directory, "journal.sqlite"),
      AIF_PERSONAL_MODE: "false",
      AIF_PEER_ENABLED: "false",
      PROJECTS_DIR: "",
      PROJECTS_MOUNT: "",
      PARTICIPANTS_MODE_ENABLED: "false",
      LOG_LEVEL: "fatal",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  })
    .trim()
    .split("\n")
    .at(-1)!;
}

describe("local execution workspace journal", () => {
  it(
    "persists scope before execution, redirects the source root, and blocks other roots or task bindings",
    () => {
      const input = seed();
      const row = data.prepareTaskExecutionWorkspace(input);
      expect(row).toMatchObject({ state: "active", revision: 1 });
      expect(row.scopeJson).not.toBeNull();
      expect(data.findTaskById(input.taskId)?.worktreePath).toBe(input.worktreePath);
      expect(data.assertTaskExecutionAllowed(input.taskId, source)).toBe(input.worktreePath);
      expect(data.assertProjectExecutionAllowed(input.projectId, input.taskId, source)).toBe(
        input.worktreePath,
      );
      expect(() => data.assertTaskExecutionAllowed(input.taskId, directory)).toThrow(
        data.TaskWorkspaceError,
      );
      expect(() => data.assertProjectExecutionAllowed("other", input.taskId, source)).toThrow(
        data.TaskWorkspaceError,
      );
      writeFileSync(join(input.worktreePath, "task.txt"), "task writes\n");
      expect(data.prepareTaskExecutionWorkspace(input).scopeJson).toBe(row.scopeJson);
      expect(() =>
        data.prepareTaskExecutionWorkspace({ ...input, snapshotCommit: "0".repeat(40) }),
      ).toThrow(data.TaskWorkspaceError);
      db.current
        .update(tasks)
        .set({ worktreePath: source })
        .where(eq(tasks.id, input.taskId))
        .run();
      expect(() => data.assertTaskExecutionAllowed(input.taskId, source)).toThrow(
        data.TaskWorkspaceError,
      );
    },
    TIMEOUT,
  );

  it(
    "never prepares a personal task before the grant/fencing gate exists",
    () => {
      const input = seed(true);
      expect(() => data.prepareTaskExecutionWorkspace(input)).toThrow(
        PersonalExecutionDisabledError,
      );
      expect(data.getTaskExecutionWorkspace(input.taskId)).toBeNull();
      expect(existsSync(input.worktreePath)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "writes plans to the registered root and blocks plan writes after checkpoint preparation",
    () => {
      const input = seed();
      data.prepareTaskExecutionWorkspace(input);
      data.persistTaskPlanForTask({
        taskId: input.taskId,
        planText: "# Scoped plan",
        planPath: "plan.md",
      });
      expect(readFileSync(join(input.worktreePath, "plan.md"), "utf8")).toContain("# Scoped plan");
      expect(existsSync(join(source, "plan.md"))).toBe(false);
      data.prepareTaskWorkspaceCheckpoint(input.taskId, "docs: plan");
      expect(() =>
        data.persistTaskPlanForTask({
          taskId: input.taskId,
          planText: "overwrite",
          planPath: "plan.md",
        }),
      ).toThrow(data.TaskWorkspaceError);
      expect(readFileSync(join(input.worktreePath, "plan.md"), "utf8")).toContain("# Scoped plan");
    },
    TIMEOUT,
  );

  it(
    "blocks writes once an intent is prepared and repeats the same verified checkpoint",
    () => {
      const input = seed();
      data.prepareTaskExecutionWorkspace(input);
      writeFileSync(join(input.worktreePath, "task.txt"), "owned\n");
      const prepared = data.prepareTaskWorkspaceCheckpoint(input.taskId, "fix: owned");
      expect(prepared.state).toBe("checkpoint_prepared");
      expect(git(source, "for-each-ref", "refs/aif")).toBe("");
      expect(() => data.assertTaskExecutionAllowed(input.taskId, source)).toThrow(
        data.TaskWorkspaceError,
      );
      const result = data.publishTaskWorkspaceCheckpoint(input.taskId);
      expect(result.status).toBe("committed");
      expect(
        data.checkpointTaskExecutionWorkspace(input.taskId, "retry uses saved intent"),
      ).toEqual(result);
      expect(data.getTaskExecutionWorkspace(input.taskId)?.state).toBe("checkpointed");
      expect(() => data.assertTaskExecutionAllowed(input.taskId, source)).toThrow(
        data.TaskWorkspaceError,
      );
    },
    TIMEOUT,
  );

  it(
    "retains preparing state after failure and refuses to adopt edits written before scope persistence",
    () => {
      const input = seed();
      mkdirSync(input.worktreePath);
      expect(() => data.prepareTaskExecutionWorkspace(input)).toThrow();
      expect(data.getTaskExecutionWorkspace(input.taskId)?.state).toBe("preparing");
      expect(data.findTaskById(input.taskId)?.worktreePath).toBeNull();
      expect(() => data.assertTaskExecutionAllowed(input.taskId, source)).toThrow(
        data.TaskWorkspaceError,
      );
      rmdirSync(input.worktreePath);
      prepareTaskCheckout(input);
      writeFileSync(join(input.worktreePath, "task.txt"), "unclaimed edit after crash\n");
      expect(() => data.prepareTaskExecutionWorkspace(input)).toThrow();
      expect(data.getTaskExecutionWorkspace(input.taskId)?.scopeJson).toBeNull();
      expect(readFileSync(join(input.worktreePath, "task.txt"), "utf8")).toBe(
        "unclaimed edit after crash\n",
      );
    },
    TIMEOUT,
  );

  it(
    "recovers a published Git ref after process death before SQLite acknowledgement",
    () => {
      const index = readFileSync(join(source, ".git/index"));
      const head = git(source, "rev-parse", "HEAD");
      runWorker("initialize");
      expect(JSON.parse(runWorker("root"))).toBe(join(directory, "task"));
      expect(JSON.parse(runWorker("prepare"))).toMatchObject({ state: "checkpoint_prepared" });
      let published: unknown;
      try {
        runWorker("publish-without-ack");
        throw new Error("Expected simulated crash");
      } catch (error) {
        const failed = error as { status?: number; stdout?: string };
        expect(failed.status).toBe(23);
        published = JSON.parse(failed.stdout!.trim().split("\n").at(-1)!);
      }
      expect(JSON.parse(runWorker("report"))).toMatchObject({
        state: "checkpoint_prepared",
        result: null,
      });
      const recovered = JSON.parse(runWorker("recover"));
      expect(recovered).toEqual(published);
      expect(JSON.parse(runWorker("report"))).toMatchObject({
        state: "checkpointed",
        result: recovered,
      });
      expect(git(source, "rev-list", "--count", `${head}..${recovered.commitSha}`)).toBe("1");
      expect(git(source, "rev-parse", "HEAD")).toBe(head);
      expect(readFileSync(join(source, ".git/index"))).toEqual(index);
    },
    TIMEOUT,
  );
});
