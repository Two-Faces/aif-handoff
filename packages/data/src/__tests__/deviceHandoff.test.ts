import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import {
  tasks,
  projects,
  participants,
  localDevice,
  taskDeviceGrants,
  taskDeviceGrantHeads,
  taskDeviceRuns,
  taskDeviceHandoffs,
  resetEnvCache,
  continuationNotesSchema,
  createSnapshotBundle,
  importSnapshotBundle,
  prepareReceivedSnapshot,
  taskCheckpointRef,
  type CodeSnapshotPackage,
  type TaskDeviceHandoffRequest,
} from "@aif/shared";

const state = { db: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => state.db,
}));
const data = await import("../index.js");
const actualServer =
  await vi.importActual<typeof import("@aif/shared/server")>("@aif/shared/server");
const databases: ReturnType<typeof createTestDb>[] = [];
function recoverProcess(
  mode: string,
  id: string,
  actorOrTransfer: string,
  revision: number,
  path: string,
) {
  const worker = fileURLToPath(new URL("./fixtures/handoffRecovery.ts", import.meta.url));
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  return spawnSync(
    process.execPath,
    ["--import", "tsx", worker, mode, id, actorOrTransfer, String(revision)],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, DATABASE_URL: path, AIF_PERSONAL_MODE: "false", LOG_LEVEL: "fatal" },
    },
  );
}
let directory: string;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  if (state.db.$client.open) state.db.$client.close();
  state.db = createTestDb();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-handoff-journal-")));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetEnvCache();
  for (const db of databases.splice(0)) if (db !== state.db && db.$client.open) db.$client.close();
  actualServer.closeDb();
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  }).trim();
}
function repository(name: string): string {
  const root = join(directory, name);
  mkdirSync(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Handoff Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, ".gitignore"), ".ai-factory/NOTES.md\n");
  writeFileSync(join(root, "task.txt"), "base\n");
  git(root, "add", ".");
  git(root, "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  return root;
}
function admin(): string {
  const id = randomUUID();
  state.db
    .insert(participants)
    .values({
      id,
      username: id,
      normalizedUsername: id,
      displayName: "Local admin",
      role: "admin",
      passwordHash: "fixture",
    })
    .run();
  return id;
}
function fixture() {
  const projectRoot = repository("source"),
    worktreePath = join(directory, "work");
  const project = data.createProject({ name: "Handoff", rootPath: projectRoot })!;
  const task = data.createTask({
    projectId: project.id,
    title: "Task",
    description: "",
    paused: true,
  })!;
  const parent = data.initializeTaskDeviceGrant(task.id);
  data.prepareTaskExecutionWorkspace({
    projectId: project.id,
    taskId: task.id,
    projectRoot,
    worktreePath,
    snapshotCommit: git(projectRoot, "rev-parse", "HEAD"),
  });
  state.db
    .update(tasks)
    .set({ executionOwner: "human", ownershipRevision: 1 })
    .where(eq(tasks.id, task.id))
    .run();
  const peerId = randomUUID(),
    participantId = admin();
  data.registerSyncPeer({
    deviceId: peerId,
    name: "Target",
    fingerprint: "b".repeat(64),
    projectIds: [project.id],
  });
  writeFileSync(join(worktreePath, "task.txt"), "task change\n");
  const request: TaskDeviceHandoffRequest = {
    id: randomUUID(),
    taskId: task.id,
    expectedGrantId: parent.grantId,
    targetDeviceId: peerId,
    notes: continuationNotesSchema.parse({ goal: "Continue", nextStep: "Verify" }),
  };
  return {
    projectRoot,
    worktreePath,
    projectId: project.id,
    taskId: task.id,
    parent,
    peerId,
    participantId,
    request,
  };
}
function stopped(f: ReturnType<typeof fixture>) {
  data.requestTaskDeviceHandoff(f.request);
  const quiescing = data.quiesceTaskDeviceHandoff(f.request.id);
  return data.confirmManualTaskHandoffStop({
    id: quiescing.id,
    expectedRevision: quiescing.revision,
    participantId: f.participantId,
  });
}
function checkpointed(f: ReturnType<typeof fixture>) {
  stopped(f);
  return data.checkpointTaskDeviceHandoff(f.request.id);
}
function importPack(
  peerId: string,
  pack: CodeSnapshotPackage,
  bundle: Buffer,
  root: string,
  name: string,
): string {
  const binding = data.bindProjectCheckout({
    projectId: pack.descriptor.projectId,
    localRoot: root,
    executionEnvironment:
      process.platform === "win32"
        ? "native_windows"
        : process.platform === "darwin"
          ? "native_macos"
          : "native_linux",
    head: git(root, "rev-parse", "HEAD"),
    branch: "main",
  });
  const fullBundle = data.describeSnapshotResource(bundle);
  const resources = [
    { resource: fullBundle, bytes: bundle },
    ...pack.blobs.map((blob) => ({
      resource: data.describeSnapshotResource(Buffer.from(blob.base64, "base64")),
      bytes: Buffer.from(blob.base64, "base64"),
    })),
  ];
  const worktreePath = join(directory, name);
  const transfer = data.beginSnapshotTransfer(
    {
      peerId,
      projectId: pack.descriptor.projectId,
      snapshotId: pack.id,
      checkoutId: binding.id,
      worktreePath,
    },
    {
      version: 1,
      snapshotId: pack.id,
      descriptor: pack.descriptor,
      context: pack.context,
      fullBundle,
      incrementalBundle: null,
      contextBlobs: resources.slice(1).map((value) => value.resource),
    },
  );
  for (const { resource, bytes } of resources)
    for (let i = 0; i < resource.chunks.length; i++) {
      data.stageSnapshotChunk(
        transfer.id,
        resource.digest,
        i,
        bytes.subarray(i * 262144, Math.min((i + 1) * 262144, resource.size)).toString("base64"),
      );
    }
  data.storeCodeSnapshotPackage(pack);
  importSnapshotBundle(root, pack, bundle, null);
  prepareReceivedSnapshot(
    {
      projectId: pack.descriptor.projectId,
      taskId: pack.descriptor.taskId,
      projectRoot: root,
      worktreePath,
      snapshotCommit: pack.descriptor.commitSha,
    },
    pack,
  );
  data.recordLocalCodeSnapshot(pack.descriptor.projectId, pack.id, root);
  data.updateSnapshotTransfer(transfer.id, {
    status: "ready",
    codeReady: true,
    contextReady: true,
    completed: true,
    selectedBundleDigest: fullBundle.digest,
  });
  return transfer.id;
}
describe("durable manual device handoff", () => {
  it("rejects malformed requests and out-of-order actions without changing authority", () => {
    const f = fixture();
    expect(() => data.getTaskDeviceHandoff(randomUUID())).toThrow(
      expect.objectContaining({ code: "handoff_missing" }),
    );
    expect(() => data.requestTaskDeviceHandoff({ ...f.request, forceStopped: true })).toThrow(
      expect.objectContaining({ code: "handoff_invalid" }),
    );
    expect(() =>
      data.requestTaskDeviceHandoff({
        ...f.request,
        targetDeviceId: data.getLocalDevice().deviceId,
      }),
    ).toThrow(expect.objectContaining({ code: "handoff_not_owner" }));
    const row = data.requestTaskDeviceHandoff(f.request);
    expect(data.listTaskDeviceHandoffs(f.projectId)).toHaveLength(1);
    expect(() => data.getReleasedTaskHandoffOffer(row.id)).toThrow(
      expect.objectContaining({ code: "handoff_wrong_phase" }),
    );
    expect(() => data.releaseTaskDeviceHandoff(row.id)).toThrow(
      expect.objectContaining({ code: "handoff_wrong_phase" }),
    );
    expect(() =>
      data.confirmManualTaskHandoffStop({
        id: row.id,
        expectedRevision: row.revision,
        participantId: f.participantId,
      }),
    ).toThrow(expect.objectContaining({ code: "handoff_wrong_phase" }));
    data.quiesceTaskDeviceHandoff(row.id);
    expect(() => data.checkpointTaskDeviceHandoff(row.id)).toThrow(
      expect.objectContaining({ code: "handoff_stop_unproven" }),
    );
    expect(data.getTaskDeviceGrant(f.taskId)).toMatchObject({ state: "owned", executionEpoch: 0 });
  }, 30000);
  it("does not let a manual confirmation substitute for stop evidence of a settled pre-supervision run", async () => {
    const f = fixture();
    state.db.update(tasks).set({ executionOwner: "ai" }).where(eq(tasks.id, f.taskId)).run();
    await data.withTaskDeviceExecution(
      { taskId: f.taskId, projectRoot: f.projectRoot },
      async () => {},
    );
    expect(state.db.select().from(taskDeviceRuns).all()[0].state).toBe("settled");
    state.db.update(tasks).set({ executionOwner: "human" }).where(eq(tasks.id, f.taskId)).run();
    data.requestTaskDeviceHandoff(f.request);
    const row = data.quiesceTaskDeviceHandoff(f.request.id);
    expect(() =>
      data.confirmManualTaskHandoffStop({
        id: row.id,
        expectedRevision: row.revision,
        participantId: f.participantId,
      }),
    ).toThrow(expect.objectContaining({ code: "handoff_stop_unproven" }));
    expect(data.getTaskDeviceGrant(f.taskId)?.activeRunId).toBeNull();
    expect(data.getTaskDeviceGrant(f.taskId)?.state).toBe("owned");
  }, 30000);
  it("freezes intent/context, releases exactly once and retains authority after lost acknowledgement", () => {
    const f = fixture();
    const first = data.requestTaskDeviceHandoff(f.request);
    expect(data.requestTaskDeviceHandoff(f.request)).toEqual(first);
    expect(() =>
      data.requestTaskDeviceHandoff({
        ...f.request,
        notes: { ...f.request.notes, goal: "Changed" },
      }),
    ).toThrow(expect.objectContaining({ code: "handoff_conflict" }));
    expect(() => data.requestTaskDeviceHandoff({ ...f.request, id: randomUUID() })).toThrow(
      expect.objectContaining({ code: "handoff_conflict" }),
    );
    const row = data.quiesceTaskDeviceHandoff(first.id);
    expect(data.quiesceTaskDeviceHandoff(first.id)).toEqual(row);
    const confirm = { id: row.id, expectedRevision: row.revision, participantId: f.participantId };
    const sealed = data.confirmManualTaskHandoffStop(confirm);
    expect(data.confirmManualTaskHandoffStop(confirm)).toEqual(sealed);
    expect(git(f.projectRoot, "for-each-ref", "refs/aif")).toBe("");
    const complete = data.checkpointTaskDeviceHandoff(row.id);
    expect(complete.phase).toBe("checkpointed");
    expect(data.checkpointTaskDeviceHandoff(row.id)).toEqual(complete);
    const offered = data.releaseTaskDeviceHandoff(row.id);
    expect(data.releaseTaskDeviceHandoff(row.id)).toEqual(offered);
    expect(data.getTaskDeviceGrant(f.taskId)).toMatchObject({
      state: "observed",
      ownerDeviceId: f.peerId,
      executionEpoch: 1,
    });
    expect(() =>
      data.cancelTaskDeviceHandoff({ ...confirm, expectedRevision: complete.revision }),
    ).toThrow(expect.objectContaining({ code: "handoff_irreversible" }));
    expect(git(f.projectRoot, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.projectRoot, "task.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(f.worktreePath, "task.txt"), "utf8")).toBe("task change\n");
  }, 60000);
  it("does not publish a changed working tree after the manual stop confirmation", () => {
    const f = fixture();
    stopped(f);
    writeFileSync(join(f.worktreePath, "task.txt"), "later edit\n");
    expect(() => data.checkpointTaskDeviceHandoff(f.request.id)).toThrow(
      expect.objectContaining({ code: "scope_changed" }),
    );
    expect(data.getTaskDeviceHandoff(f.request.id).phase).toBe("quiescing");
    expect(data.getTaskDeviceGrant(f.taskId)?.state).toBe("owned");
  }, 30000);
  it("blocks stale confirmations, unknown actors, changed inputs and revoked destinations", () => {
    const f = fixture();
    data.requestTaskDeviceHandoff(f.request);
    const row = data.quiesceTaskDeviceHandoff(f.request.id);
    expect(() =>
      data.confirmManualTaskHandoffStop({
        id: row.id,
        expectedRevision: row.revision,
        participantId: randomUUID(),
      }),
    ).toThrow(expect.objectContaining({ code: "handoff_manual_confirmation_required" }));
    expect(() =>
      data.confirmManualTaskHandoffStop({
        id: row.id,
        expectedRevision: row.revision - 1,
        participantId: f.participantId,
      }),
    ).toThrow(expect.objectContaining({ code: "handoff_conflict" }));
    data.updateTask(f.taskId, { plan: "Changed by human" });
    expect(() =>
      data.confirmManualTaskHandoffStop({
        id: row.id,
        expectedRevision: row.revision,
        participantId: f.participantId,
      }),
    ).toThrow(expect.objectContaining({ code: "handoff_input_changed" }));
    expect(
      data.cancelTaskDeviceHandoff({
        id: row.id,
        expectedRevision: row.revision,
        participantId: f.participantId,
      }).phase,
    ).toBe("cancelled");
    data.revokeSyncPeer(f.peerId);
    expect(() => data.requestTaskDeviceHandoff({ ...f.request, id: randomUUID() })).toThrow(
      expect.objectContaining({ code: "peer_revoked" }),
    );
  }, 30000);
  it("fences active callbacks and never treats timeout, an expired lock or a finished adapter as a manual stop", async () => {
    const f = fixture();
    state.db.update(tasks).set({ executionOwner: "ai" }).where(eq(tasks.id, f.taskId)).run();
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let controller!: AbortController;
    const running = data.withTaskDeviceExecution(
      { taskId: f.taskId, projectRoot: f.projectRoot },
      async () => {
        expect(() => data.requestTaskDeviceHandoff(f.request)).toThrow(
          expect.objectContaining({ code: "handoff_manual_confirmation_required" }),
        );
        const guard = data.createTaskDeviceRuntimeGuard(f.taskId);
        controller = guard.abortController;
        await guard.run(
          async () =>
            new Promise<void>((resolve) => {
              finish = resolve;
              entered();
            }),
        );
      },
    );
    const failure = expect(running).rejects.toMatchObject({ code: expect.stringMatching(/^run_/) });
    await started;
    data.requestTaskDeviceHandoff(f.request);
    data.quiesceTaskDeviceHandoff(f.request.id);
    finish();
    await failure;
    expect(controller.signal.aborted).toBe(true);
    expect(data.getTaskDeviceGrant(f.taskId)?.activeRunId).not.toBeNull();
    state.db
      .update(tasks)
      .set({ executionOwner: "human", lockedBy: null, lockedUntil: "2000-01-01" })
      .where(eq(tasks.id, f.taskId))
      .run();
    // Even bypassing the input change check in this fixture cannot fabricate stop proof.
    const { handoffInputDigest } = await import("../deviceHandoffScope.js");
    state.db
      .update(taskDeviceHandoffs)
      .set({
        inputDigest: handoffInputDigest(
          state.db.select().from(tasks).where(eq(tasks.id, f.taskId)).get()!,
        ),
      })
      .run();
    const row = data.getTaskDeviceHandoff(f.request.id);
    expect(() =>
      data.confirmManualTaskHandoffStop({
        id: row.id,
        expectedRevision: row.revision,
        participantId: f.participantId,
      }),
    ).toThrow(expect.objectContaining({ code: "handoff_stop_unproven" }));
    expect(state.db.select().from(taskDeviceRuns).all()[0].state).toBe("uncertain");
  }, 30000);
  it("accepts only a verified local snapshot, clears session reuse, preserves dirty user roots and handles duplicate delivery", async () => {
    const f = fixture(),
      sourceDb = state.db,
      sourceDevice = data.getLocalDevice().deviceId;
    checkpointed(f);
    const pack = data.loadCodeSnapshotPackage(
      data.getTaskDeviceHandoff(f.request.id).snapshotId!,
      f.projectId,
    );
    const bundle = createSnapshotBundle(f.projectRoot, pack);
    const parentRow = sourceDb
      .select()
      .from(taskDeviceGrants)
      .where(eq(taskDeviceGrants.id, f.parent.grantId))
      .get()!;
    const offered = data.releaseTaskDeviceHandoff(f.request.id);
    databases.push(sourceDb);
    state.db = createTestDb();
    data.getLocalDevice();
    state.db.update(localDevice).set({ deviceId: f.peerId }).run();
    const targetRoot = repository("target");
    writeFileSync(join(targetRoot, "task.txt"), "keep my edits\n");
    state.db
      .insert(projects)
      .values({ id: f.projectId, name: "Target", rootPath: targetRoot })
      .run();
    state.db
      .insert(tasks)
      .values({
        id: f.taskId,
        projectId: f.projectId,
        title: "Task",
        description: "",
        executionOwner: "human",
        paused: true,
        sessionId: "old-local-session",
      })
      .run();
    state.db.insert(taskDeviceGrants).values(parentRow).run();
    state.db
      .insert(taskDeviceGrantHeads)
      .values({ ...f.parent, state: "observed" })
      .run();
    data.registerSyncPeer({
      deviceId: sourceDevice,
      name: "Source",
      fingerprint: "a".repeat(64),
      projectIds: [f.projectId],
    });
    expect(data.receiveTaskDeviceHandoff(sourceDevice, offered).state).toBe("received");
    expect(data.getTaskDeviceGrant(f.taskId)?.state).toBe("pending");
    expect(() => data.acceptTaskDeviceHandoff(offered.id, randomUUID())).toThrow();
    const localTransfer = importPack(sourceDevice, pack, bundle, targetRoot, "received");
    state.db
      .update(tasks)
      .set({ branchName: "keep-local-branch" })
      .where(eq(tasks.id, f.taskId))
      .run();
    expect(() => data.acceptTaskDeviceHandoff(offered.id, localTransfer)).toThrow(
      expect.objectContaining({ code: "handoff_conflict" }),
    );
    state.db.update(tasks).set({ branchName: null }).where(eq(tasks.id, f.taskId)).run();
    data.updateTask(f.taskId, { plan: "Different plan" });
    expect(() => data.acceptTaskDeviceHandoff(offered.id, localTransfer)).toThrow(
      expect.objectContaining({ code: "handoff_input_changed" }),
    );
    data.updateTask(f.taskId, { plan: null });
    const targetCheckout = {
      projectId: f.projectId,
      taskId: f.taskId,
      projectRoot: targetRoot,
      worktreePath: join(directory, "received"),
      snapshotCommit: pack.descriptor.commitSha,
    };
    const checkpointRef = taskCheckpointRef(targetCheckout),
      userHead = git(targetRoot, "rev-parse", "main");
    git(targetRoot, "symbolic-ref", checkpointRef, "refs/heads/main");
    expect(() => data.acceptTaskDeviceHandoff(offered.id, localTransfer)).toThrow(
      expect.objectContaining({ code: "checkpoint_conflict" }),
    );
    expect(data.getTaskDeviceGrant(f.taskId)?.state).toBe("pending");
    expect(git(targetRoot, "rev-parse", "main")).toBe(userHead);
    git(targetRoot, "symbolic-ref", "--delete", checkpointRef);
    const targetDatabase = join(directory, "target.sqlite");
    await state.db.$client.backup(targetDatabase);
    const crash = recoverProcess("accept-crash", offered.id, localTransfer, 0, targetDatabase);
    expect(crash.status, crash.stderr).toBe(86);
    state.db.$client.close();
    state.db = actualServer.getDb(targetDatabase) as ReturnType<typeof createTestDb>;
    expect(data.getTaskDeviceGrant(f.taskId)?.state).toBe("pending");
    expect(data.getTaskExecutionWorkspace(f.taskId)).toBeNull();
    expect(git(targetRoot, "rev-parse", checkpointRef)).toBe(pack.descriptor.commitSha);
    const accepted = data.acceptTaskDeviceHandoff(offered.id, localTransfer);
    expect(accepted.phase).toBe("accepted");
    expect(data.acceptTaskDeviceHandoff(offered.id, localTransfer)).toEqual(accepted);
    expect(data.getTaskDeviceGrant(f.taskId)).toMatchObject({
      state: "accepted",
      ownerDeviceId: f.peerId,
      executionEpoch: 1,
      activeRunId: null,
    });
    expect(data.findTaskById(f.taskId)).toMatchObject({
      sessionId: null,
      worktreePath: join(directory, "received"),
      paused: true,
      executionOwner: "human",
    });
    state.db
      .update(tasks)
      .set({ executionOwner: "ai", paused: false, status: "planning" })
      .where(eq(tasks.id, f.taskId))
      .run();
    expect(data.findCoordinatorTaskCandidates("planner", 10)).toEqual([]);
    await expect(
      data.withTaskDeviceExecution({ taskId: f.taskId, projectRoot: targetRoot }, async () => {}),
    ).rejects.toMatchObject({ code: "run_continuation_required" });
    expect(data.getTaskDeviceGrant(f.taskId)?.activeRunId).toBeNull();
    state.db
      .update(tasks)
      .set({ executionOwner: "human", paused: true, status: "backlog" })
      .where(eq(tasks.id, f.taskId))
      .run();
    expect(readFileSync(join(targetRoot, "task.txt"), "utf8")).toBe("keep my edits\n");
    expect(readFileSync(join(directory, "received", "task.txt"), "utf8")).toBe("task change\n");
    const receipt = data.receiveTaskDeviceHandoff(sourceDevice, offered);
    expect(receipt.state).toBe("accepted");
    const targetDb = state.db;
    databases.push(targetDb);
    state.db = sourceDb;
    expect(data.recordTaskHandoffReceipt(f.peerId, receipt).phase).toBe("accepted");
    expect(data.recordTaskHandoffReceipt(f.peerId, receipt).phase).toBe("accepted");
    expect(data.getTaskDeviceGrant(f.taskId)?.ownerDeviceId).toBe(f.peerId);
    expect(data.getReleasedTaskHandoffOffer(offered.id)).toEqual(offered);
    // Return to the original device in a fresh exact checkout. A replay of
    // the old offer must never roll back the newly accepted epoch.
    state.db = targetDb;
    writeFileSync(join(directory, "received", "task.txt"), "edited on target\n");
    const back = {
      ...f,
      participantId: admin(),
      request: {
        ...f.request,
        id: randomUUID(),
        expectedGrantId: data.getTaskDeviceGrant(f.taskId)!.grantId,
        targetDeviceId: sourceDevice,
      },
    };
    checkpointed(back);
    const returnPack = data.loadCodeSnapshotPackage(
      data.getTaskDeviceHandoff(back.request.id).snapshotId!,
      f.projectId,
    );
    const returnBundle = createSnapshotBundle(targetRoot, returnPack);
    const returning = data.releaseTaskDeviceHandoff(back.request.id);
    state.db = sourceDb;
    data.receiveTaskDeviceHandoff(f.peerId, returning);
    const returnTransfer = importPack(
      f.peerId,
      returnPack,
      returnBundle,
      f.projectRoot,
      "returned",
    );
    expect(data.acceptTaskDeviceHandoff(returning.id, returnTransfer)).toMatchObject({
      phase: "accepted",
      previousWorkspaceJson: expect.any(String),
    });
    expect(data.getTaskDeviceGrant(f.taskId)).toMatchObject({
      state: "accepted",
      ownerDeviceId: sourceDevice,
      executionEpoch: 2,
    });
    expect(readFileSync(join(directory, "returned", "task.txt"), "utf8")).toBe(
      "edited on target\n",
    );
    expect(readFileSync(join(f.worktreePath, "task.txt"), "utf8")).toBe("task change\n");
    state.db = targetDb;
    expect(data.receiveTaskDeviceHandoff(sourceDevice, offered).state).toBe("accepted");
    expect(data.getTaskDeviceGrant(f.taskId)).toMatchObject({
      state: "observed",
      ownerDeviceId: sourceDevice,
      executionEpoch: 2,
    });
  }, 90000);
  it("recovers frozen context, published Git refs and a lost release ACK in new processes", async () => {
    const f = fixture();
    mkdirSync(join(f.worktreePath, ".ai-factory"));
    writeFileSync(join(f.worktreePath, ".ai-factory", "NOTES.md"), "original portable context\n");
    data.requestTaskDeviceHandoff({ ...f.request, portablePaths: [".ai-factory/NOTES.md"] });
    const row = data.quiesceTaskDeviceHandoff(f.request.id);
    const path = join(directory, "recovery.sqlite");
    await state.db.$client.backup(path);
    const worker = fileURLToPath(new URL("./fixtures/handoffRecovery.ts", import.meta.url));
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const run = (mode: string) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", worker, mode, row.id, f.participantId, String(row.revision)],
        {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
          env: {
            ...process.env,
            DATABASE_URL: path,
            AIF_PERSONAL_MODE: "false",
            LOG_LEVEL: "fatal",
          },
        },
      );
    expect(run("confirm").status).toBe(86);
    state.db.$client.close();
    // The public getDb type omits Drizzle's client; this fixture uses the
    // concrete handle for backup/cleanup, just like createTestDb.
    state.db = actualServer.getDb(path) as ReturnType<typeof createTestDb>;
    const snapshot = data.getTaskDeviceHandoff(row.id).snapshotId!;
    writeFileSync(join(f.worktreePath, ".ai-factory", "NOTES.md"), "late local context\n");
    expect(run("publish-without-ack").status).toBe(86);
    expect(data.getTaskExecutionWorkspace(f.taskId)?.state).toBe("checkpoint_prepared");
    expect(run("checkpoint").status).toBe(86);
    expect(data.getTaskDeviceHandoff(row.id)).toMatchObject({
      phase: "checkpointed",
      snapshotId: snapshot,
    });
    const pack = data.loadCodeSnapshotPackage(snapshot, f.projectId);
    expect(Buffer.from(pack.blobs[0].base64, "base64").toString()).toBe(
      "original portable context\n",
    );
    expect(run("release").status).toBe(86);
    const again = run("retry-release");
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual(data.getReleasedTaskHandoffOffer(row.id));
    expect(data.getTaskDeviceGrant(f.taskId)).toMatchObject({
      state: "observed",
      ownerDeviceId: f.peerId,
      executionEpoch: 1,
    });
    expect(readFileSync(join(f.worktreePath, ".ai-factory", "NOTES.md"), "utf8")).toBe(
      "late local context\n",
    );
  }, 90000);
  it("keeps the source owned if the peer is revoked before release and allows local cancellation", () => {
    const f = fixture();
    const row = checkpointed(f);
    data.revokeSyncPeer(f.peerId);
    expect(() => data.releaseTaskDeviceHandoff(row.id)).toThrow(
      expect.objectContaining({ code: "peer_revoked" }),
    );
    expect(data.getTaskDeviceGrant(f.taskId)?.state).toBe("owned");
    expect(
      data.cancelTaskDeviceHandoff({
        id: row.id,
        expectedRevision: row.revision,
        participantId: f.participantId,
      }).phase,
    ).toBe("cancelled");
  }, 30000);
});
