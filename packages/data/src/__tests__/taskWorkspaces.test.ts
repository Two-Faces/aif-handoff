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
  continuationNotesSchema,
  contextSnapshotBlobs,
  codeSnapshots,
  taskWorkspaceContinuations,
  projects,
} from "@aif/shared";
import { eq } from "drizzle-orm";

const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const data = await import("../index.js");
const TIMEOUT = 30_000;
const notes = continuationNotesSchema.parse({
  goal: "Continue this task",
  nextStep: "Verify native behavior",
});
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
    "continues a sealed snapshot in a new root, retaining the old checkout and a linear code/context history",
    () => {
      const input = seed();
      data.prepareTaskExecutionWorkspace(input);
      data.persistTaskPlanForTask({
        taskId: input.taskId,
        planText: "# Continue plan",
        planPath: "plan.md",
      });
      writeFileSync(join(input.worktreePath, "task.txt"), "first checkpoint\n");
      const checkpoint = data.checkpointTaskExecutionWorkspace(input.taskId, "first checkpoint");
      const contextPath = ".ai-factory/RULES.md";
      mkdirSync(join(input.worktreePath, ".ai-factory"));
      // Make this portable file ignored only on the source machine; the next root
      // must exclude it from code scopes even without this local ignore rule.
      writeFileSync(join(source, ".git/info/exclude"), ".ai-factory/\n");
      writeFileSync(join(input.worktreePath, contextPath), "AIF 2.19 context\n");
      const pack = data.captureTaskCodeSnapshot({
        taskId: input.taskId,
        notes,
        portablePaths: [contextPath],
      });
      expect(pack.descriptor.commitSha).toBe(checkpoint.commitSha);
      expect(data.loadCodeSnapshotPackage(pack.id, input.projectId)).toEqual(pack);
      const sourceIndex = readFileSync(join(source, ".git/index"));
      const oldIndex = readFileSync(
        join(git(input.worktreePath, "rev-parse", "--absolute-git-dir"), "index"),
      );
      db.current
        .update(tasks)
        .set({
          sessionId: "local-session-must-not-resume",
          activeRuntimeSelectionJson: "{}",
          planPath: join(input.worktreePath, "plan.md"),
        })
        .where(eq(tasks.id, input.taskId))
        .run();
      const continuation = {
        id: "next-step",
        taskId: input.taskId,
        snapshotId: pack.id,
        worktreePath: join(directory, "next"),
      };
      const next = data.continueTaskExecutionWorkspace(continuation);
      expect(next).toMatchObject({
        state: "active",
        sourceSnapshotId: pack.id,
        snapshotCommit: checkpoint.commitSha,
      });
      expect(data.continueTaskExecutionWorkspace(continuation)).toEqual(next);
      expect(data.findTaskById(input.taskId)).toMatchObject({
        worktreePath: continuation.worktreePath,
        planPath: "plan.md",
        sessionId: null,
        activeRuntimeSelectionJson: null,
      });
      expect(readFileSync(join(continuation.worktreePath, contextPath), "utf8")).toBe(
        "AIF 2.19 context\n",
      );
      expect(readFileSync(join(continuation.worktreePath, "plan.md"), "utf8")).toContain(
        "# Continue plan",
      );
      // The new scope persists its explicit exclusions, independently of ignores.
      writeFileSync(join(source, ".git/info/exclude"), "");
      writeFileSync(join(continuation.worktreePath, contextPath), "Updated next-step context\n");
      writeFileSync(join(continuation.worktreePath, "task.txt"), "second checkpoint\n");
      const second = data.checkpointTaskExecutionWorkspace(input.taskId, "second checkpoint");
      expect(second.paths).toEqual(["task.txt"]);
      expect(git(source, "rev-parse", `${second.commitSha}^`)).toBe(checkpoint.commitSha);
      const nextPack = data.captureTaskCodeSnapshot({ taskId: input.taskId, notes });
      expect(nextPack.descriptor.parentSnapshotId).toBe(pack.id);
      expect(nextPack.context.files.map((file) => file.path)).toContain(contextPath);
      expect(nextPack.descriptor.contextDigest).not.toBe(pack.descriptor.contextDigest);
      const explicitEmpty = data.captureTaskCodeSnapshot({
        taskId: input.taskId,
        notes,
        portablePaths: [],
      });
      expect(explicitEmpty.context.files.map((file) => file.path)).not.toContain(contextPath);
      expect(git(source, "rev-parse", "main")).toBe(input.snapshotCommit);
      expect(readFileSync(join(source, ".git/index"))).toEqual(sourceIndex);
      expect(
        readFileSync(join(git(input.worktreePath, "rev-parse", "--absolute-git-dir"), "index")),
      ).toEqual(oldIndex);
      expect(readFileSync(join(input.worktreePath, "task.txt"), "utf8")).toBe("first checkpoint\n");
      expect(
        db.current.select().from(taskWorkspaceContinuations).get()?.previousWorkspaceJson,
      ).toContain('"state":"checkpointed"');
    },
    TIMEOUT,
  );

  it(
    "validates complete immutable packages on ingress and on project-scoped load",
    () => {
      const input = seed();
      expect(() => data.captureTaskCodeSnapshot({ taskId: input.taskId, notes })).toThrow();
      data.prepareTaskExecutionWorkspace(input);
      expect(() => data.captureTaskCodeSnapshot({ taskId: input.taskId, notes })).toThrow();
      data.persistTaskPlanForTask({
        taskId: input.taskId,
        planText: "# Context",
        planPath: "AGENTS.md",
      });
      data.checkpointTaskExecutionWorkspace(input.taskId, "context");
      const pack = data.captureTaskCodeSnapshot({ taskId: input.taskId, notes });
      expect(data.storeCodeSnapshotPackage(pack)).toEqual(pack);
      expect(() => data.storeCodeSnapshotPackage({ ...pack, blobs: [] })).toThrow();
      expect(() => data.loadCodeSnapshotPackage(pack.id, "different-project")).toThrow();
      const blob = pack.blobs[0];
      db.current
        .update(contextSnapshotBlobs)
        .set({ base64: "Y29ycnVwdA==" })
        .where(eq(contextSnapshotBlobs.digest, blob.digest))
        .run();
      expect(() => data.storeCodeSnapshotPackage(pack)).toThrow();
      expect(() => data.loadCodeSnapshotPackage(pack.id, input.projectId)).toThrow();
      db.current
        .delete(contextSnapshotBlobs)
        .where(eq(contextSnapshotBlobs.digest, blob.digest))
        .run();
      expect(() => data.loadCodeSnapshotPackage(pack.id, input.projectId)).toThrow();
      data.storeCodeSnapshotPackage(pack);
      db.current
        .update(codeSnapshots)
        .set({ contextJson: "{}" })
        .where(eq(codeSnapshots.id, pack.id))
        .run();
      expect(() => data.storeCodeSnapshotPackage(pack)).toThrow();
      expect(() => data.loadCodeSnapshotPackage(pack.id, input.projectId)).toThrow();
      db.current
        .update(codeSnapshots)
        .set({ contextJson: "invalid-json" })
        .where(eq(codeSnapshots.id, pack.id))
        .run();
      expect(() => data.loadCodeSnapshotPackage(pack.id, input.projectId)).toThrow();
    },
    TIMEOUT,
  );

  it(
    "reserves a single continuation and blocks conflicting requests, changed plans, running tasks and personal policy",
    () => {
      const input = seed();
      data.prepareTaskExecutionWorkspace(input);
      data.checkpointTaskExecutionWorkspace(input.taskId, "no change");
      const pack = data.captureTaskCodeSnapshot({ taskId: input.taskId, notes });
      const request = {
        id: "next",
        taskId: input.taskId,
        snapshotId: pack.id,
        worktreePath: join(directory, "next"),
      };
      expect(() =>
        data.beginTaskWorkspaceContinuation({ ...request, worktreePath: input.worktreePath }),
      ).toThrow();
      const reserved = data.beginTaskWorkspaceContinuation(request);
      expect(data.beginTaskWorkspaceContinuation(request)).toEqual(reserved);
      expect(() => data.beginTaskWorkspaceContinuation({ ...request, id: "duplicate" })).toThrow();
      expect(() =>
        data.beginTaskWorkspaceContinuation({ ...request, worktreePath: join(directory, "other") }),
      ).toThrow();
      expect(() => data.activateTaskWorkspaceContinuation("missing")).toThrow();
      db.current
        .update(tasks)
        .set({ lockedBy: "running-process" })
        .where(eq(tasks.id, input.taskId))
        .run();
      expect(() => data.activateTaskWorkspaceContinuation(request.id)).toThrow();
      expect(existsSync(request.worktreePath)).toBe(false);
      db.current
        .update(tasks)
        .set({ lockedBy: null, plan: "changed after capture" })
        .where(eq(tasks.id, input.taskId))
        .run();
      expect(() => data.activateTaskWorkspaceContinuation(request.id)).toThrow();
      expect(existsSync(request.worktreePath)).toBe(false);
      db.current
        .update(projects)
        .set({ personalMode: true })
        .where(eq(projects.id, input.projectId))
        .run();
      expect(() => data.activateTaskWorkspaceContinuation(request.id)).toThrow(
        PersonalExecutionDisabledError,
      );
      expect(() => data.captureTaskCodeSnapshot({ taskId: input.taskId, notes })).toThrow(
        PersonalExecutionDisabledError,
      );
      expect(existsSync(request.worktreePath)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "refuses to adopt unclaimed target edits after a crash and rejects plan paths outside the owned root",
    () => {
      const input = seed();
      data.prepareTaskExecutionWorkspace(input);
      expect(() =>
        data.persistTaskPlanForTask({
          taskId: input.taskId,
          planText: "escape",
          planPath: join(directory, "outside.md"),
        }),
      ).toThrow();
      expect(existsSync(join(directory, "outside.md"))).toBe(false);
      db.current
        .update(tasks)
        .set({ planPath: "owned-plan.md" })
        .where(eq(tasks.id, input.taskId))
        .run();
      mkdirSync(join(input.worktreePath, ".ai-factory"));
      writeFileSync(
        join(input.worktreePath, ".ai-factory", "config.yaml"),
        "paths:\n  plan: ../outside.md\n  fix_plan: ../outside-fix.md\n",
      );
      data.persistTaskPlanForTask({ taskId: input.taskId, planText: "# Owned plan", isFix: false });
      expect(readFileSync(join(input.worktreePath, "owned-plan.md"), "utf8")).toBe(
        "# Owned plan\n",
      );
      expect(existsSync(join(directory, "outside.md"))).toBe(false);
      expect(() =>
        data.persistTaskPlanForTask({
          taskId: input.taskId,
          planText: "# Escape fix",
          isFix: true,
        }),
      ).toThrow();
      expect(existsSync(join(directory, "outside-fix.md"))).toBe(false);
      data.checkpointTaskExecutionWorkspace(input.taskId, "no change");
      const pack = data.captureTaskCodeSnapshot({ taskId: input.taskId, notes });
      const request = {
        id: "next",
        taskId: input.taskId,
        snapshotId: pack.id,
        worktreePath: join(directory, "next"),
      };
      data.beginTaskWorkspaceContinuation(request);
      prepareTaskCheckout({
        ...input,
        worktreePath: request.worktreePath,
        snapshotCommit: pack.descriptor.commitSha,
      });
      writeFileSync(join(request.worktreePath, "task.txt"), "unclaimed after process death\n");
      expect(() => data.activateTaskWorkspaceContinuation(request.id)).toThrow();
      expect(data.getTaskExecutionWorkspace(input.taskId)?.state).toBe("checkpointed");
      expect(data.findTaskById(input.taskId)?.worktreePath).toBe(input.worktreePath);
      expect(readFileSync(join(request.worktreePath, "task.txt"), "utf8")).toBe(
        "unclaimed after process death\n",
      );
    },
    TIMEOUT,
  );

  it(
    "recovers prepared code/context files in a new process without rereading mutable source notes",
    () => {
      runWorker("initialize");
      runWorker("prepare");
      runWorker("recover");
      const reserved = JSON.parse(runWorker("reserve-continuation"));
      runWorker("materialize-continuation");
      writeFileSync(
        join(directory, "task", ".ai-factory", "RULES.md"),
        "changed source after capture\n",
      );
      const activated = JSON.parse(runWorker("activate-continuation"));
      expect(activated).toMatchObject({
        state: "active",
        sourceSnapshotId: reserved.snapshotId,
        worktreePath: join(directory, "next"),
      });
      expect(JSON.parse(runWorker("activate-continuation"))).toEqual(activated);
      expect(readFileSync(join(directory, "next", ".ai-factory", "RULES.md"), "utf8")).toBe(
        "frozen context before restart\n",
      );
      expect(JSON.parse(runWorker("root"))).toBe(join(directory, "next"));
    },
    TIMEOUT,
  );

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
