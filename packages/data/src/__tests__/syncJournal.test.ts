import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  projects,
  syncOperations,
  syncStreams,
  syncOperationSchema,
  syncStreamKey,
  type SyncOperation,
  type CausalContext,
} from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aif/shared/server")>()),
  getDb: () => testDb.current,
}));
const journal = await import("../syncJournal.js");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1);
const peer = id(2);
const incarnation = id(3);
const stream = syncStreamKey(projectId, peer, incarnation);
const fields = {
  name: "Original",
  groupName: null,
  pinnedAt: null,
  createdAt: "2026-10-02T00:00:00Z",
};

function operation(sequence: number, patch: Record<string, unknown> = {}): SyncOperation {
  return syncOperationSchema.parse({
    protocolVersion: 1,
    schemaVersion: 1,
    operationId: id(100 + sequence),
    originDeviceId: peer,
    deviceIncarnation: incarnation,
    projectId,
    streamKey: stream,
    originSequence: sequence,
    entityType: "project",
    entityId: projectId,
    intent: sequence === 1 ? "create" : "update",
    causalContext: sequence === 1 ? {} : { [stream]: sequence - 1 },
    actorKind: "participant",
    fields: sequence === 1 ? fields : { name: `Edit ${sequence}` },
    ...patch,
  });
}
function project(
  operation: Pick<SyncOperation, "entityType" | "entityId" | "projectId">,
  values: Record<string, unknown> | null,
): void {
  if (operation.entityType !== "project") return;
  if (!values) {
    testDb.current.delete(projects).where(eq(projects.id, operation.projectId)).run();
    return;
  }
  testDb.current
    .insert(projects)
    .values({
      id: operation.projectId,
      name: String(values.name),
      rootPath: "receiver-local",
      personalMode: true,
    })
    .onConflictDoUpdate({ target: projects.id, set: { name: String(values.name) } })
    .run();
}
const receive = (operations: SyncOperation[], writer = project) =>
  journal.receiveSyncOperations(
    { peerDeviceId: peer, allowedProjectIds: [projectId], operations },
    writer,
  );
beforeEach(() => {
  testDb.current.$client.close();
  testDb.current = createTestDb();
});
afterEach(() => vi.restoreAllMocks());

describe("transactional sync journal", () => {
  it("preserves a gap inbox and outgoing journal across a SQLite backup and reopen", async () => {
    receive([operation(1), operation(3)]);
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "update",
      fields: { groupName: "Local pending edit" },
    });
    const directory = mkdtempSync(join(tmpdir(), "aif-sync-durable-"));
    const file = join(directory, "backup.sqlite");
    const actual = await vi.importActual<typeof import("@aif/shared/server")>("@aif/shared/server");
    try {
      await testDb.current.$client.backup(file);
      actual.closeDb();
      const reopened = actual.getDb(file);
      expect(reopened.select().from(syncOperations).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operationId: operation(3).operationId,
            applied: false,
            outgoing: false,
          }),
          expect.objectContaining({ outgoing: true, applied: true }),
        ]),
      );
      expect(
        reopened.select().from(syncStreams).where(eq(syncStreams.streamKey, stream)).get()
          ?.appliedSequence,
      ).toBe(1);
    } finally {
      actual.closeDb();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("does not ACK gaps and applies an out-of-order batch exactly once without echo", () => {
    expect(receive([operation(3)])).toMatchObject({ applied: 0, watermarks: { [projectId]: {} } });
    expect(receive([operation(1)])).toMatchObject({
      applied: 1,
      watermarks: { [projectId]: { [stream]: 1 } },
    });
    expect(receive([operation(2)])).toMatchObject({
      applied: 2,
      watermarks: { [projectId]: { [stream]: 3 } },
    });
    const projection = vi.fn(project);
    expect(receive([operation(1), operation(2), operation(3)], projection)).toMatchObject({
      accepted: 0,
      applied: 0,
    });
    expect(projection).not.toHaveBeenCalled();
    expect(testDb.current.select().from(projects).get()?.name).toBe("Edit 3");
    expect(journal.listOutgoingSyncOperations(projectId, "peer")).toEqual([]);
  });

  it("rolls projection, inbox and cursor back together when projection fails before ACK", () => {
    const failed: import("../syncJournal.js").SyncProjectionWriter = (op, values) => {
      project(op, values);
      throw new Error("Injected crash");
    };
    expect(() => receive([operation(1)], failed)).toThrow("Injected crash");
    expect(testDb.current.select().from(projects).all()).toEqual([]);
    expect(testDb.current.select().from(syncOperations).all()).toEqual([]);
    expect(journal.getSyncWatermarks(projectId)).toEqual({});
    expect(receive([operation(1)]).applied).toBe(1);
  });

  it("rejects operation ID/sequence collisions and unauthorized projects", () => {
    receive([operation(1)]);
    expect(() => receive([operation(1, { fields: { ...fields, name: "Forged" } })])).toThrow(
      expect.objectContaining({ code: "operation_collision" }),
    );
    expect(() => receive([operation(1, { operationId: id(900) })])).toThrow(
      expect.objectContaining({ code: "operation_collision" }),
    );
    expect(() =>
      journal.receiveSyncOperations(
        { peerDeviceId: id(999), allowedProjectIds: [projectId], operations: [operation(1)] },
        project,
      ),
    ).toThrow(expect.objectContaining({ code: "stream_scope_mismatch" }));
    expect(() =>
      journal.receiveSyncOperations(
        { peerDeviceId: peer, allowedProjectIds: [], operations: [operation(1)] },
        project,
      ),
    ).toThrow(expect.objectContaining({ code: "stream_scope_mismatch" }));
    expect(journal.readSyncEntity(projectId, "project", projectId)?.name).toBe("Original");
  });

  it("keeps domain writes and source counters in the same transaction", () => {
    const change = {
      projectId,
      entityId: projectId,
      entityType: "project" as const,
      intent: "create" as const,
      fields,
    };
    expect(() =>
      testDb.current.transaction((tx) => {
        tx.insert(projects)
          .values({ id: projectId, name: "Original", rootPath: "source-local", personalMode: true })
          .run();
        journal.recordLocalSyncChange(change);
        throw new Error("crash before commit");
      }),
    ).toThrow("crash before commit");
    expect(testDb.current.select().from(syncOperations).all()).toEqual([]);
    expect(testDb.current.select().from(syncStreams).all()).toEqual([]);
    expect(testDb.current.select().from(projects).all()).toEqual([]);
    expect(journal.recordLocalSyncChange(change)?.originSequence).toBe(1);
  });

  it("retains outbox after lost ACK and bounds ACK by contiguous sent data", () => {
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "create",
      fields,
    });
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "update",
      fields: { name: "Local edit" },
    });
    const outgoing = journal.listOutgoingSyncOperations(projectId, peer);
    const ownStream = outgoing[0]!.streamKey;
    expect(() => journal.markSyncOperationsSent(peer, [outgoing[1]!])).toThrow(
      expect.objectContaining({ code: "invalid_ack" }),
    );
    journal.markSyncOperationsSent(peer, outgoing);
    expect(journal.listOutgoingSyncOperations(projectId, peer)).toHaveLength(2);
    expect(() => journal.acknowledgeSyncOperations(peer, projectId, { [ownStream]: 3 })).toThrow(
      expect.objectContaining({ code: "invalid_ack" }),
    );
    journal.acknowledgeSyncOperations(peer, projectId, { [ownStream]: 1 });
    expect(journal.listOutgoingSyncOperations(projectId, peer)).toHaveLength(1);
    journal.acknowledgeSyncOperations(peer, projectId, { [ownStream]: 2 });
    expect(journal.listOutgoingSyncOperations(projectId, peer)).toEqual([]);
    expect(() => journal.acknowledgeSyncOperations(peer, projectId, { [ownStream]: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_ack" }),
    );
  });

  it("keeps concurrent values until explicit resolution with all observed parents", () => {
    const source = journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "create",
      fields,
    })!;
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "update",
      fields: { name: "Windows" },
    });
    const context: CausalContext = { [source.streamKey]: 1 };
    receive([operation(1, { intent: "update", fields: { name: "Mac" }, causalContext: context })]);
    const conflict = journal.listSyncConflicts(projectId)[0]!;
    expect(conflict.versions.map((version) => version.value).sort()).toEqual(["Mac", "Windows"]);
    expect(() =>
      journal.recordLocalSyncChange({
        projectId,
        entityId: projectId,
        entityType: "project",
        intent: "update",
        fields: { name: "overwrite" },
      }),
    ).toThrow(expect.objectContaining({ code: "sync_conflict_requires_resolution" }));
    expect(() =>
      journal.recordLocalSyncChange({
        projectId,
        entityId: projectId,
        entityType: "project",
        intent: "resolve",
        fields: { name: "choice" },
        parents: { name: [] },
      }),
    ).toThrow(expect.objectContaining({ code: "resolution_changed" }));
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "resolve",
      fields: { name: "choice" },
      parents: { name: conflict.versions.map((version) => version.dot) },
    });
    expect(journal.listSyncConflicts(projectId)).toEqual([]);
    expect(journal.readSyncEntity(projectId, "project", projectId)?.name).toBe("choice");
  });

  it("does not resurrect a deleted entity after an old concurrent edit", () => {
    const source = journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "create",
      fields,
    })!;
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "delete",
      fields: {},
    });
    receive([
      operation(1, {
        intent: "update",
        fields: { name: "old offline edit" },
        causalContext: { [source.streamKey]: 1 },
      }),
    ]);
    expect(journal.readSyncEntity(projectId, "project", projectId)).toBeNull();
  });

  it("uses independent sequence spaces for differently allowlisted projects", () => {
    const otherProject = id(42);
    const first = journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "create",
      fields,
    })!;
    const other = journal.recordLocalSyncChange({
      projectId: otherProject,
      entityId: otherProject,
      entityType: "project",
      intent: "create",
      fields,
    })!;
    const second = journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "update",
      fields: { groupName: "Changed" },
    })!;
    expect([first.originSequence, other.originSequence, second.originSequence]).toEqual([1, 1, 2]);
    expect(Object.keys(second.causalContext)).toEqual([first.streamKey]);
    expect(journal.listOutgoingSyncOperations(projectId, peer).map((op) => op.projectId)).toEqual([
      projectId,
      projectId,
    ]);
  });

  it("does not bypass a causally known human owner with an agent transition", () => {
    receive([operation(1)]);
    const workflow = {
      status: "backlog",
      executionOwner: "human",
      ownershipRevision: 1,
      assignees: [],
    };
    const taskFields = {
      title: "Task",
      description: "",
      plan: null,
      priority: 0,
      position: 1000,
      workflow,
      attachments: [],
      tags: [],
      isFix: false,
      plannerMode: "fast",
      planDocs: false,
      planTests: false,
      skipReview: false,
      useSubagents: false,
      runPlanImprove: false,
      runPostVerify: false,
      implementationLog: null,
      reviewComments: null,
      roadmapAlias: null,
      scheduledAt: null,
      createdAt: "2026-10-02T00:00:00Z",
    };
    receive([
      operation(2, { entityType: "task", entityId: id(50), intent: "create", fields: taskFields }),
    ]);
    expect(() =>
      receive([
        operation(3, {
          entityType: "task",
          entityId: id(50),
          actorKind: "agent",
          fields: { workflow: { ...workflow, status: "implementing" } },
        }),
      ]),
    ).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(journal.getSyncWatermarks(projectId)[stream]).toBe(2);
  });

  it("suppresses outgoing echo even when a projection calls a local journal helper", () => {
    const callback = vi.fn(() => {
      expect(journal.isApplyingRemoteSync()).toBe(true);
      expect(
        journal.recordLocalSyncChange({
          projectId,
          entityId: projectId,
          entityType: "project",
          intent: "update",
          fields: { name: "echo" },
        }),
      ).toBeNull();
    });
    receive([operation(1)], callback);
    expect(journal.isApplyingRemoteSync()).toBe(false);
    expect(journal.listOutgoingSyncOperations(projectId, peer)).toEqual([]);
  });
});
