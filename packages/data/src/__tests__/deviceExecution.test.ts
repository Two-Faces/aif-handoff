import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@aif/shared/server";
import {
  localDevice,
  resetEnvCache,
  taskDeviceGrantHeads,
  taskDeviceGrants,
  taskDeviceRuns,
  tasks,
  projects,
  syncFields,
  type TaskDeviceGrant,
} from "@aif/shared";

const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const data = await import("../index.js");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
let directory: string;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  db.current.$client.close();
  db.current = createTestDb();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-device-execution-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
function seed(personalMode = false) {
  const project = data.createProject({
    name: "Device execution",
    rootPath: join(directory, "source"),
    personalMode,
  })!;
  const task = data.createTask({
    projectId: project.id,
    title: "task",
    description: "",
    paused: true,
    autoMode: false,
  })!;
  return { project, task };
}
function workspace() {
  const { project, task } = seed();
  mkdirSync(project.rootPath);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project.rootPath, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fencing Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(project.rootPath, "task.txt"), "base\n");
  git("add", "task.txt");
  git("-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  data.prepareTaskExecutionWorkspace({
    taskId: task.id,
    projectId: project.id,
    projectRoot: project.rootPath,
    worktreePath: join(directory, "task"),
    snapshotCommit: git("rev-parse", "HEAD"),
  });
  const grant = data.initializeTaskDeviceGrant(task.id);
  return { project, task, grant, input: { taskId: task.id, projectRoot: project.rootPath } };
}
function switchDevice(deviceId: string) {
  db.current.update(localDevice).set({ deviceId }).where(eq(localDevice.slot, 1)).run();
}
function pair(projectId: string, deviceId: string) {
  data.registerSyncPeer({
    deviceId,
    name: "Peer",
    fingerprint: "c".repeat(64),
    projectIds: [projectId],
  });
}
function releaseFixture(taskId: string, transferId: string, snapshotId: string) {
  // Simulates the P14 transaction. There is intentionally no production proof
  // writer/force flag in P13: an abort or expired heartbeat must not reach it.
  db.current
    .update(taskDeviceGrantHeads)
    .set({ state: "released", releasedTransferId: transferId, releasedSnapshotId: snapshotId })
    .where(eq(taskDeviceGrantHeads.taskId, taskId))
    .run();
}
function received() {
  const { project, task } = seed(true);
  const owner = data.getLocalDevice().deviceId;
  const target = randomUUID();
  switchDevice(target);
  pair(project.id, owner);
  const parent = data.initializeTaskDeviceGrant(task.id);
  const next: TaskDeviceGrant = {
    version: 1,
    projectId: project.id,
    taskId: task.id,
    ownerDeviceId: target,
    executionEpoch: 1,
    predecessorId: parent.grantId,
    issuerDeviceId: owner,
    transferId: randomUUID(),
    snapshotId: "b".repeat(64),
  };
  return { project, task, owner, parent, next };
}

describe("durable device execution authority", () => {
  it("derives identical genesis from the creator on every replica and never reinitializes relinquished authority", () => {
    const { task } = seed(true);
    const original = data.initializeTaskDeviceGrant(task.id);
    expect(data.initializeTaskDeviceGrant(task.id)).toEqual(original);
    switchDevice(randomUUID());
    db.current.delete(taskDeviceGrantHeads).run();
    db.current.delete(taskDeviceGrants).run();
    const replica = data.initializeTaskDeviceGrant(task.id);
    expect(replica).toMatchObject({
      grantId: original.grantId,
      ownerDeviceId: original.ownerDeviceId,
      state: "observed",
    });
    expect(data.claimTask(task.id, "other", 1)).toBe(false);
  });
  it("requires explicit fresh standalone enrollment and rejects absent/deleted/conflicting creation", () => {
    const { task } = seed();
    data.updateTask(task.id, { paused: false });
    expect(() => data.initializeTaskDeviceGrant(task.id)).toThrow(
      expect.objectContaining({ code: "grant_not_ready" }),
    );
    expect(() => data.initializeTaskDeviceGrant(randomUUID())).toThrow(
      expect.objectContaining({ code: "grant_invalid" }),
    );
    const personal = seed(true);
    db.current.delete(syncFields).where(eq(syncFields.entityId, personal.task.id)).run();
    expect(() => data.initializeTaskDeviceGrant(personal.task.id)).toThrow(
      expect.objectContaining({ code: "grant_conflict" }),
    );
  });
  it("requires durable release proof and issues only one idempotent successor per epoch", () => {
    const { project, task } = seed(true);
    const head = data.initializeTaskDeviceGrant(task.id);
    const target = randomUUID();
    pair(project.id, target);
    const input = {
      taskId: task.id,
      expectedGrantId: head.grantId,
      targetDeviceId: target,
      transferId: randomUUID(),
      snapshotId: "b".repeat(64),
    };
    expect(() => data.issueTaskDeviceSuccessor(input)).toThrow(
      expect.objectContaining({ code: "release_not_proven" }),
    );
    releaseFixture(task.id, input.transferId, input.snapshotId);
    const next = data.issueTaskDeviceSuccessor(input);
    expect(next).toMatchObject({
      ownerDeviceId: target,
      executionEpoch: 1,
      issuerDeviceId: head.ownerDeviceId,
    });
    expect(data.issueTaskDeviceSuccessor(input)).toEqual(next);
    expect(() => data.issueTaskDeviceSuccessor({ ...input, transferId: randomUUID() })).toThrow(
      expect.objectContaining({ code: "grant_conflict" }),
    );
    expect(data.initializeTaskDeviceGrant(task.id)).toMatchObject({
      state: "observed",
      ownerDeviceId: target,
      executionEpoch: 1,
    });
    switchDevice(randomUUID());
    expect(() => data.issueTaskDeviceSuccessor(input)).toThrow(
      expect.objectContaining({ code: "grant_not_owned" }),
    );
  });
  it("stages received authority without accepting it and durably quarantines a fork", () => {
    const { task, owner, next } = received();
    const staged = data.receiveTaskDeviceSuccessor(owner, next);
    expect(staged).toMatchObject({ state: "pending", executionEpoch: 1 });
    expect(data.receiveTaskDeviceSuccessor(owner, next)).toEqual(staged);
    expect(() =>
      data.receiveTaskDeviceSuccessor(owner, { ...next, snapshotId: "d".repeat(64) }),
    ).toThrow(expect.objectContaining({ code: "grant_conflict" }));
    expect(data.getTaskDeviceGrant(task.id)?.state).toBe("conflicted");
    expect(data.receiveTaskDeviceSuccessor(owner, next).state).toBe("conflicted");
  });
  it("rejects relays, missing ancestry, skipped epochs, swapped tasks and revoked peers", () => {
    const { project, task, owner, next } = received();
    for (const patch of [
      { issuerDeviceId: randomUUID() },
      { taskId: randomUUID() },
      { executionEpoch: 2 },
      { predecessorId: "a".repeat(64) },
      { runId: randomUUID() },
    ])
      expect(() => data.receiveTaskDeviceSuccessor(owner, { ...next, ...patch })).toThrow();
    expect(data.getTaskDeviceGrant(task.id)?.state).toBe("observed");
    data.revokeSyncPeer(owner);
    expect(() => data.receiveTaskDeviceSuccessor(owner, next)).toThrow(
      expect.objectContaining({ code: "peer_revoked" }),
    );
    expect(() => data.assertProjectExecutionAllowed(project.id, task.id)).toThrow(
      expect.objectContaining({ code: "personal_execution_disabled" }),
    );
  });
  it("retains the authority journal after board deletion", () => {
    const { task } = seed();
    const head = data.initializeTaskDeviceGrant(task.id);
    data.deleteTask(task.id);
    expect(data.getTaskDeviceGrant(task.id)).toEqual(head);
    expect(() => data.initializeTaskDeviceGrant(task.id)).toThrow();
  });
  it("verifies persisted predecessor bytes and descriptor bindings before accepting a successor", () => {
    const { parent, owner, next } = received();
    const row = db.current
      .select()
      .from(taskDeviceGrants)
      .where(eq(taskDeviceGrants.id, parent.grantId))
      .get()!;
    for (const grantJson of [
      "not json",
      "null",
      JSON.stringify({ ...JSON.parse(row.grantJson), ownerDeviceId: randomUUID() }),
    ]) {
      db.current
        .update(taskDeviceGrants)
        .set({ grantJson })
        .where(eq(taskDeviceGrants.id, parent.grantId))
        .run();
      expect(() => data.receiveTaskDeviceSuccessor(owner, next)).toThrow(
        expect.objectContaining({ code: "grant_invalid" }),
      );
    }
    expect(data.getTaskDeviceGrant(next.taskId)?.state).toBe("observed");
  });
});

describe("fenced local run scopes", () => {
  it("reserves one run, rejects an independent concurrent runner and allows nested work in the exact root", async () => {
    const { input, task, grant } = workspace();
    let unblock!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let runId = "";
    const first = data.withTaskDeviceExecution(input, async (executionRoot) => {
      runId = data.getTaskDeviceGrant(task.id)!.activeRunId!;
      data.assertTaskExecutionAllowed(task.id, executionRoot);
      await data.withTaskDeviceExecution(input, async (nestedRoot) => {
        expect(nestedRoot).toBe(executionRoot);
        data.saveTaskSessionId(task.id, "session-a");
        data.updateTaskHeartbeat(task.id);
        expect(data.findTaskById(task.id)?.sessionId).toBe("session-a");
      });
      await new Promise<void>((resolve) => {
        unblock = resolve;
        ready();
      });
      data.updateTaskStatus(task.id, "planning");
      return "finished";
    });
    await started;
    await expect(data.withTaskDeviceExecution(input, async () => "second")).rejects.toMatchObject({
      code: "run_busy",
    });
    unblock();
    expect(await first).toBe("finished");
    expect(data.getTaskDeviceRun(runId)).toMatchObject({
      state: "settled",
      grantId: grant.grantId,
      executionEpoch: 0,
    });
    expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBeNull();
    expect(data.findTaskById(task.id)).toMatchObject({ status: "planning", sessionId: null });
  });
  it("fences callbacks from completed runs, including while another run owns the same grant", async () => {
    const { input, task } = workspace();
    let late!: () => void;
    await data.withTaskDeviceExecution(input, async () => {
      late = data.bindTaskDeviceExecution(() => data.saveTaskSessionId(task.id, "stale"));
    });
    expect(late).toThrow(expect.objectContaining({ code: "run_fenced" }));
    await data.withTaskDeviceExecution(input, async () => {
      expect(late).toThrow(expect.objectContaining({ code: "run_fenced" }));
      data.saveTaskSessionId(task.id, "current");
    });
    expect(data.findTaskById(task.id)?.sessionId).toBe("current");
  });
  it("fails closed after a caught nested timeout until P14 proves that writing stopped", async () => {
    const { input, task } = workspace();
    let finish!: () => void;
    let nested!: Promise<unknown>;
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        nested = data.withTaskDeviceExecution(input, async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          data.updateTaskStatus(task.id, "done");
        });
        // Models an outer timeout handler returning while the runtime still runs.
        return "timed out";
      }),
    ).rejects.toMatchObject({ code: "run_fenced" });
    const runId = data.getTaskDeviceGrant(task.id)!.activeRunId!;
    expect(data.getTaskDeviceRun(runId)?.state).toBe("uncertain");
    finish();
    await expect(nested).rejects.toMatchObject({ code: "run_fenced" });
    await expect(data.withTaskDeviceExecution(input, async () => "takeover")).rejects.toMatchObject(
      { code: "run_busy" },
    );
    expect(data.findTaskById(task.id)?.status).toBe("backlog");
  });
  it("does not turn a swallowed nested failure into successful completion", async () => {
    const { input, task } = workspace();
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        await data
          .withTaskDeviceExecution(input, async () => {
            throw new Error("runtime failure");
          })
          .catch(() => undefined);
      }),
    ).rejects.toMatchObject({ code: "run_fenced" });
    expect(data.getTaskDeviceRun(data.getTaskDeviceGrant(task.id)!.activeRunId!)?.state).toBe(
      "uncertain",
    );
  });
  it("tracks asynchronous event callbacks so an unawaited callback cannot outlive a successful run", async () => {
    const { input, task } = workspace();
    await data.withTaskDeviceExecution(input, async () => {
      const callback = data.bindTaskDeviceExecution(async () => {
        await Promise.resolve();
        data.saveTaskSessionId(task.id, "awaited callback");
        return 42;
      });
      expect(await callback()).toBe(42);
    });
    let finish!: () => void;
    let event!: Promise<void>;
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        const callback = data.bindTaskDeviceExecution(async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          data.saveTaskSessionId(task.id, "late callback");
        });
        event = callback();
      }),
    ).rejects.toMatchObject({ code: "run_fenced" });
    finish();
    await expect(event).rejects.toMatchObject({ code: "run_fenced" });
    expect(data.findTaskById(task.id)?.sessionId).toBe("awaited callback");
  });
  it("rejects an old result after a human edits the plan outside the run scope", async () => {
    const { input, task } = workspace();
    let finish!: () => void;
    const running = data.withTaskDeviceExecution(input, async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      data.updateTask(task.id, { qaStatus: "done" });
    });
    data.updateTask(task.id, { plan: "New human plan" });
    finish();
    await expect(running).rejects.toMatchObject({ code: "run_fenced" });
    expect(data.findTaskById(task.id)).toMatchObject({ plan: "New human plan", qaStatus: "idle" });
  });
  it("rejects wrong roots, cross-task writes and changed ownership before publishing results", async () => {
    const { input, task } = workspace();
    const other = seed().task;
    await expect(
      data.withTaskDeviceExecution({ ...input, projectRoot: directory }, async () => "bad root"),
    ).rejects.toMatchObject({ code: "root_mismatch" });
    await expect(
      data.withTaskDeviceExecution(input, async (executionRoot) => {
        expect(() => data.assertTaskDeviceExecution(task.id, directory)).toThrow(
          expect.objectContaining({ code: "run_root_mismatch" }),
        );
        expect(() => data.updateTask(other.id, { title: "cross-task" })).toThrow(
          expect.objectContaining({ code: "run_fenced" }),
        );
        expect(() => data.assertProjectExecutionAllowed(other.projectId!)).toThrow(
          expect.objectContaining({ code: "taskless_execution_denied" }),
        );
        data.assertTaskExecutionAllowed(task.id, executionRoot);
        db.current
          .update(tasks)
          .set({ ownershipRevision: 1, executionOwner: "human" })
          .where(eq(tasks.id, task.id))
          .run();
        data.updateTaskStatus(task.id, "done");
      }),
    ).rejects.toMatchObject({ code: "run_fenced" });
    expect(data.findTaskById(task.id)?.status).toBe("backlog");
    expect(data.findTaskById(other.id)?.title).toBe("task");
  });
  it("checks the grant epoch/state at result write time inside the mutation transaction", async () => {
    const { input, task } = workspace();
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        db.current
          .update(taskDeviceGrantHeads)
          .set({ state: "released", executionEpoch: 1 })
          .where(eq(taskDeviceGrantHeads.taskId, task.id))
          .run();
        expect(() =>
          data.persistTaskPlanForTask({ taskId: task.id, planText: "late", planPath: "plan.md" }),
        ).toThrow(expect.objectContaining({ code: "run_fenced" }));
        expect(() =>
          data.createTaskComment({ taskId: task.id, author: "agent", message: "late" }),
        ).toThrow(expect.objectContaining({ code: "run_fenced" }));
        data.updateTask(task.id, { title: "late title" });
      }),
    ).rejects.toMatchObject({ code: "run_fenced" });
    expect(data.findTaskById(task.id)?.title).toBe("task");
    expect(data.listTaskComments(task.id)).toEqual([]);
  });
  it("keeps M1's personal execution ban even with a locally owned grant and registered checkout", async () => {
    const { input, task, project } = workspace();
    db.current
      .update(projects)
      .set({ personalMode: true })
      .where(eq(projects.id, project.id))
      .run();
    const execute = vi.fn(async () => "must not run");
    await expect(data.withTaskDeviceExecution(input, execute)).rejects.toMatchObject({
      code: "personal_execution_disabled",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(data.getTaskDeviceGrant(task.id)?.activeRunId).toBeNull();
  });
  it("excludes managed tasks from legacy claims, TTL recovery, watchdog, QA reset and scheduling", () => {
    const { task, project } = seed();
    const grant = data.initializeTaskDeviceGrant(task.id);
    db.current
      .update(tasks)
      .set({
        paused: false,
        autoMode: true,
        status: "planning",
        lockedBy: "old",
        lockedUntil: "2000-01-01",
        updatedAt: "2000-01-01",
        lastHeartbeatAt: "2000-01-01",
        qaStatus: "running",
        qaCheckStatus: "running",
      })
      .where(eq(tasks.id, task.id))
      .run();
    expect(data.claimTask(task.id, "new", 1000)).toBe(false);
    expect(
      data.claimCoordinatorTaskIfEligible({
        taskId: task.id,
        expectedProjectId: project.id,
        expectedStatus: "planning",
        coordinatorId: "new",
        lockDurationMs: 1000,
      }),
    ).toBeUndefined();
    expect(data.releaseStaleTaskClaims()).toBe(0);
    expect(data.resetStaleQaRuns()).toBe(0);
    expect(data.resetStaleQaCheckRuns()).toBe(0);
    data.renewTaskClaim(task.id, "old", 10_000);
    data.releaseTaskClaim(task.id, "old");
    expect(data.findTaskById(task.id)).toMatchObject({
      lockedBy: "old",
      lockedUntil: "2000-01-01",
      qaStatus: "running",
      qaCheckStatus: "running",
    });
    expect(data.findCoordinatorTaskCandidates("planner", 1)).toEqual([]);
    expect(data.listCoordinatorActionableProjectIds(1)).toEqual([]);
    expect(data.listStaleInProgressTasks()).toEqual([]);
    expect(data.tryStartQaRun(task.id)).toBe(false);
    expect(data.tryStartQaCheckRun(task.id)).toBe(false);
    expect(data.claimBacklogTaskForAdvance(task.id)).toBe(false);
    expect(data.getTaskDeviceGrant(task.id)).toEqual(grant);
  });
  it("requires scope for internal result writers but keeps human board edits available", () => {
    const { task, project } = seed();
    data.initializeTaskDeviceGrant(task.id);
    for (const mutate of [
      () => data.setTaskFields(task.id, { sessionId: "unfenced" }),
      () => data.updateTaskHeartbeat(task.id),
      () => data.updateTaskStatus(task.id, "done"),
      () => data.clearTaskRuntimeLimitSnapshot(task.id),
      () => data.updateTask(task.id, { qaStatus: "error" }),
      () => data.createTaskComment({ taskId: task.id, author: "agent", message: "unfenced" }),
      () => data.checkpointTaskExecutionWorkspace(task.id, "unfenced"),
      () => data.assertTaskExecutionAllowed(task.id),
    ])
      expect(mutate).toThrow(expect.objectContaining({ code: "run_scope_required" }));
    expect(() => data.assertProjectExecutionAllowed(project.id)).toThrow(
      expect.objectContaining({ code: "taskless_execution_denied" }),
    );
    data.updateTask(task.id, { title: "Human edit" });
    data.createTaskComment({ taskId: task.id, author: "human", message: "Human comment" });
    expect(data.findTaskById(task.id)).toMatchObject({
      title: "Human edit",
      status: "backlog",
      sessionId: null,
    });
  });
  it("retains standalone behavior and never manufactures grants as a launch side effect", async () => {
    const { task, project } = seed();
    expect(
      await data.withTaskDeviceExecution(
        { taskId: task.id, projectRoot: project.rootPath },
        async (executionRoot) => executionRoot,
      ),
    ).toBe(project.rootPath);
    expect(data.getTaskDeviceGrant(task.id)).toBeNull();
    expect(data.bindTaskDeviceExecution(() => 42)()).toBe(42);
  });
  it("retains a run after process death and rejects a new coordinator despite expired leases", async () => {
    const { input, task } = workspace();
    const filename = join(directory, "restart.sqlite");
    await db.current.$client.backup(filename);
    const script = `import * as data from '@aif/data';
      const input = JSON.parse(process.env.FENCE_INPUT);
      try { await data.withTaskDeviceExecution(input, async () => { process.stdout.write('RESERVED'); process.exit(0); }); }
      catch (error) { process.stdout.write(JSON.stringify({code:error.code, head:data.getTaskDeviceGrant(input.taskId)})); }`;
    const run = () =>
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
        env: {
          ...process.env,
          DATABASE_URL: filename,
          FENCE_INPUT: JSON.stringify(input),
          AIF_PERSONAL_MODE: "false",
          AIF_PEER_ENABLED: "false",
          PROJECTS_DIR: "",
          PROJECTS_MOUNT: "",
          LOG_LEVEL: "fatal",
        },
      });
    expect(run()).toBe("RESERVED");
    const recovered = JSON.parse(run());
    expect(recovered).toMatchObject({
      code: "run_busy",
      head: { taskId: task.id, state: "owned", executionEpoch: 0 },
    });
    expect(recovered.head.activeRunId).toBeTruthy();
    expect(db.current.select().from(taskDeviceRuns).all()).toEqual([]);
  }, 30_000);
});
