import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { participants, syncOperations, taskComments, tasks, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const state = { db: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => state.db,
}));
const data = await import("../index.js");
const journal = await import("../syncJournal.js");
const { materializeSharedEntity } = await import("../syncDomain.js");
let left: ReturnType<typeof createTestDb>;
let right: ReturnType<typeof createTestDb>;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  state.db.$client.close();
  left = createTestDb();
  right = createTestDb();
  state.db = left;
});
afterEach(() => {
  state.db = createTestDb();
  left.$client.close();
  right.$client.close();
  vi.unstubAllEnvs();
  resetEnvCache();
});
function person() {
  const id = crypto.randomUUID();
  state.db
    .insert(participants)
    .values({
      id,
      username: id,
      normalizedUsername: id,
      displayName: "Owner",
      role: "member",
      passwordHash: "LOCAL_SECRET",
    })
    .run();
  return id;
}
function setup() {
  const owner = person();
  const project = data.createProject({
    name: "Board",
    rootPath: "PRIVATE_ROOT",
    personalMode: true,
  })!;
  const task = data.createTask({
    projectId: project.id,
    title: "First",
    description: "Original",
    executionOwner: "human",
    assigneeIds: [owner],
    actor: { kind: "participant", id: owner, displayNameSnapshot: "Owner" },
  })!;
  return { owner, project, task };
}
function transfer(projectId: string, source = left, target = right) {
  state.db = source;
  const device = data.getLocalDevice().deviceId;
  const ops = journal.listOutgoingSyncOperations(projectId, "test-peer");
  state.db = target;
  journal.receiveSyncOperations(
    { peerDeviceId: device, allowedProjectIds: [projectId], operations: ops },
    materializeSharedEntity,
  );
  return ops;
}
describe("shared domain writers and materialization", () => {
  it("retains concurrent plans, requires explicit parents and converges after resolution", () => {
    const { project, task } = setup();
    transfer(project.id);
    data.updateTask(
      task.id,
      { plan: "Right" },
      { expected: data.getEntitySyncRevisions(project.id, "task", task.id) },
    );
    state.db = left;
    data.updateTask(
      task.id,
      { plan: "Left" },
      { expected: data.getEntitySyncRevisions(project.id, "task", task.id) },
    );
    transfer(project.id, right, left);
    transfer(project.id);
    const conflict = data.listSyncConflicts(project.id).find((item) => item.field === "plan")!;
    expect(conflict.versions.map((version) => version.value).sort()).toEqual(["Left", "Right"]);
    expect(() =>
      data.updateTask(
        task.id,
        { plan: "Silent overwrite" },
        { expected: data.getEntitySyncRevisions(project.id, "task", task.id) },
      ),
    ).toThrow(expect.objectContaining({ code: "sync_conflict_requires_resolution" }));
    const resolution = {
      projectId: project.id,
      entityType: "task" as const,
      entityId: task.id,
      field: "plan",
      value: "Merged",
      parents: conflict.versions.map((version) => version.dot),
      actor: { kind: "anonymous" as const, id: null, displayNameSnapshot: null },
    };
    expect(() =>
      data.resolveSyncConflict({ ...resolution, parents: resolution.parents.slice(0, 1) }),
    ).toThrow(expect.objectContaining({ code: "resolution_changed" }));
    data.resolveSyncConflict(resolution);
    transfer(project.id, right, left);
    expect(data.listSyncConflicts(project.id)).toEqual([]);
    expect(data.findTaskById(task.id)?.plan).toBe("Merged");
  });
  it("replicates attribution with different local UUIDs, maps permissions explicitly and never echoes", () => {
    const { owner, project, task } = setup();
    const comment = data.createTaskComment({
      taskId: task.id,
      author: "human",
      participantId: owner,
      message: "Offline comment",
    })!;
    const ops = transfer(project.id);
    expect(JSON.stringify(ops)).not.toMatch(
      /PRIVATE_ROOT|LOCAL_SECRET|passwordHash|runtimeProfileId/,
    );
    expect(data.findProjectById(project.id)).toMatchObject({ rootPath: "", personalMode: true });
    expect(data.getTaskOwnership(task.id)?.assignees).toEqual([]);
    expect(data.toTaskResponse(data.findTaskById(task.id)!)).toMatchObject({
      personalMode: true,
      paused: true,
      autoMode: false,
      unresolvedAssignees: [{ displayName: "Owner" }],
    });
    const logical = data.listLogicalParticipants(project.id)[0]!;
    expect(state.db.select().from(participants).all()).toEqual([]);
    expect(
      state.db.select().from(taskComments).where(eq(taskComments.id, comment.id)).get(),
    ).toMatchObject({
      message: "Offline comment",
      participantId: null,
      logicalAuthorId: logical.id,
    });
    expect(data.listTaskExecutorHistory(task.id)[0]?.logicalAssignees).toEqual([
      { id: logical.id, displayName: "Owner" },
    ]);
    const local = person();
    expect(local).not.toBe(owner);
    data.bindLogicalParticipant({
      projectId: project.id,
      logicalParticipantId: logical.id,
      participantId: local,
    });
    expect(data.getTaskOwnership(task.id)?.assignees).toMatchObject([{ participantId: local }]);
    expect(
      state.db.select().from(taskComments).where(eq(taskComments.id, comment.id)).get()
        ?.participantId,
    ).toBe(local);
    expect(journal.listOutgoingSyncOperations(project.id, "test-peer")).toEqual([]);
    journal.receiveSyncOperations(
      { peerDeviceId: ops[0]!.originDeviceId, allowedProjectIds: [project.id], operations: ops },
      materializeSharedEntity,
    );
    expect(data.listTaskExecutorHistory(task.id)).toHaveLength(1);
  });

  it("requires plan/workflow CAS and rolls back both domain state and journal on stale writes", () => {
    const { project, task } = setup();
    const expected = data.getEntitySyncRevisions(project.id, "task", task.id);
    expect(() => data.updateTask(task.id, { plan: "No revision" })).toThrow(
      expect.objectContaining({ code: "sync_revision_required" }),
    );
    data.updateTask(task.id, { plan: "Accepted" }, { expected });
    const count = state.db.select().from(syncOperations).all().length;
    expect(() =>
      data.updateTask(task.id, { plan: "Lost", title: "Lost too" }, { expected }),
    ).toThrow(expect.objectContaining({ code: "sync_revision_conflict" }));
    expect(data.findTaskById(task.id)).toMatchObject({ title: "First", plan: "Accepted" });
    expect(state.db.select().from(syncOperations).all()).toHaveLength(count);
    expect(() => data.setTaskFields(task.id, { manualReviewRequired: true })).toThrow(
      expect.objectContaining({ code: "sync_revision_required" }),
    );
    transfer(project.id);
    expect(data.findTaskById(task.id)?.plan).toBe("Accepted");
  });

  it("journals position without timestamps, merges independent edits, and removes children on delete", () => {
    const { project, task } = setup();
    const originalStamp = data.findTaskById(task.id)!.updatedAt;
    transfer(project.id);
    data.updateTask(task.id, { description: "Right edit" });
    state.db = left;
    data.updateTaskPositionOnly(task.id, 42);
    expect(data.findTaskById(task.id)!.updatedAt).toBe(originalStamp);
    data.updateTask(task.id, { title: "Left edit" });
    transfer(project.id, right, left);
    transfer(project.id);
    expect(data.findTaskById(task.id)).toMatchObject({
      title: "Left edit",
      description: "Right edit",
      position: 42,
    });
    state.db = left;
    data.createTaskComment({ taskId: task.id, author: "agent", message: "Keep ID" });
    data.deleteTask(task.id);
    transfer(project.id);
    expect(data.findTaskById(task.id)).toBeUndefined();
    expect(state.db.select().from(taskComments).all()).toEqual([]);
    state.db = left;
    data.deleteProject(project.id);
    transfer(project.id);
    expect(data.findProjectById(project.id)).toBeUndefined();
  });

  it("excludes manually unpaused personal tasks from maintenance queues", () => {
    const { project, task } = setup();
    state.db
      .update(tasks)
      .set({ paused: false, status: "planning" })
      .where(eq(tasks.id, task.id))
      .run();
    data.setAutoQueueMode(project.id, true);
    expect(data.listStaleInProgressTasks()).toEqual([]);
    expect(data.listAutoQueueProjects()).toEqual([]);
    state.db
      .update(tasks)
      .set({ status: "backlog", scheduledAt: "2020-01-01" })
      .where(eq(tasks.id, task.id))
      .run();
    expect(data.listDueScheduledTasks("2030-01-01")).toEqual([]);
  });
});
