import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import type { CheckpointManifest, SyncOperation } from "@aif/shared";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aif/shared/server")>()),
  getDb: () => testDb.current,
}));
const journal = await import("../syncJournal.js");
const checkpoints = await import("../syncCheckpoints.js");
const projectId = "00000000-0000-4000-8000-000000000001";
const base = {
  name: "Original",
  groupName: null,
  pinnedAt: null,
  createdAt: "2026-10-02T00:00:00Z",
};
const noop = () => undefined;

function resetDb() {
  testDb.current.$client.close();
  testDb.current = createTestDb();
}
beforeEach(resetDb);
function fixture() {
  const first = journal.recordLocalSyncChange({
    projectId,
    entityId: projectId,
    entityType: "project",
    intent: "create",
    fields: base,
  })!;
  const manifest = checkpoints.createSyncCheckpoint(projectId);
  const chunk = checkpoints.readSyncCheckpointChunk(manifest.checkpointId, 0);
  return { first, manifest, chunk };
}
function begin(manifest: CheckpointManifest) {
  return checkpoints.beginIncomingCheckpoint(manifest.producerDeviceId, [projectId], manifest);
}
function receive(operation: SyncOperation) {
  return journal.receiveSyncOperations(
    {
      peerDeviceId: operation.originDeviceId,
      allowedProjectIds: [projectId],
      operations: [operation],
    },
    noop,
  );
}

describe("checkpoint bootstrap", () => {
  it("stages gaps/replays and advances applied watermarks only after complete verification", () => {
    const { manifest, chunk } = fixture();
    resetDb();
    expect(begin(manifest)).toEqual({ next: 0, complete: false });
    expect(
      checkpoints.stageIncomingCheckpoint(
        manifest.producerDeviceId,
        manifest.checkpointId,
        chunk.records.slice(2),
      ),
    ).toEqual({ next: 0, complete: false });
    expect(journal.getSyncWatermarks(projectId)).toEqual({});
    expect(() =>
      checkpoints.finishIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, noop),
    ).toThrow(expect.objectContaining({ code: "checkpoint_incomplete" }));
    checkpoints.stageIncomingCheckpoint(
      manifest.producerDeviceId,
      manifest.checkpointId,
      chunk.records.slice(0, 2),
    );
    expect(begin(manifest).next).toBe(manifest.recordCount);
    expect(
      checkpoints.finishIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, noop),
    ).toEqual(manifest.watermarks);
    expect(journal.readSyncEntity(projectId, "project", projectId)).toEqual(base);
    const duplicate = vi.fn(noop);
    checkpoints.finishIncomingCheckpoint(
      manifest.producerDeviceId,
      manifest.checkpointId,
      duplicate,
    );
    expect(duplicate).not.toHaveBeenCalled();
    expect(journal.listOutgoingSyncOperations(projectId, "peer")).toEqual([]);
  });

  it("keeps a consistent cut and merges local edits made while bootstrap is downloading", () => {
    const { first } = fixture();
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "update",
      fields: { groupName: "Source group" },
    });
    const manifest = checkpoints.createSyncCheckpoint(projectId);
    const chunk = checkpoints.readSyncCheckpointChunk(manifest.checkpointId, 0);
    const afterCut = journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "update",
      fields: { pinnedAt: "2026-10-02T01:00:00Z" },
    })!;
    expect(manifest.watermarks[first.streamKey]).toBe(2);
    resetDb();
    receive(first);
    begin(manifest);
    const local = journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "update",
      fields: { name: "Local edit during bootstrap" },
    })!;
    checkpoints.stageIncomingCheckpoint(
      manifest.producerDeviceId,
      manifest.checkpointId,
      chunk.records,
    );
    checkpoints.finishIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, noop);
    expect(journal.readSyncEntity(projectId, "project", projectId)).toMatchObject({
      name: "Local edit during bootstrap",
      groupName: "Source group",
      pinnedAt: null,
    });
    expect(journal.getSyncWatermarks(projectId)[local.streamKey]).toBe(1);
    receive(afterCut);
    expect(journal.readSyncEntity(projectId, "project", projectId)?.pinnedAt).toBe(
      "2026-10-02T01:00:00Z",
    );
    expect(journal.listOutgoingSyncOperations(projectId, manifest.producerDeviceId)).toHaveLength(
      1,
    );
  });

  it("rejects tampering without a partial projection or ACK", () => {
    const { manifest, chunk } = fixture();
    const tampered = chunk.records.map((entry) =>
      entry.record.field === "name"
        ? {
            ...entry,
            record: {
              ...entry.record,
              versions: entry.record.versions.map((version) => ({ ...version, value: "Tampered" })),
            },
          }
        : entry,
    );
    resetDb();
    begin(manifest);
    checkpoints.stageIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, tampered);
    expect(() =>
      checkpoints.finishIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, noop),
    ).toThrow(expect.objectContaining({ code: "invalid_checkpoint" }));
    expect(journal.getSyncWatermarks(projectId)).toEqual({});
    expect(journal.readSyncEntity(projectId, "project", projectId)).toBeNull();
  });

  it("rolls the final installation back on projection failure, then safely retries", () => {
    const { manifest, chunk } = fixture();
    resetDb();
    begin(manifest);
    checkpoints.stageIncomingCheckpoint(
      manifest.producerDeviceId,
      manifest.checkpointId,
      chunk.records,
    );
    expect(() =>
      checkpoints.finishIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, () => {
        throw new Error("crash at install");
      }),
    ).toThrow("crash at install");
    expect(journal.getSyncWatermarks(projectId)).toEqual({});
    expect(journal.readSyncEntity(projectId, "project", projectId)).toBeNull();
    checkpoints.finishIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, noop);
    expect(journal.readSyncEntity(projectId, "project", projectId)).toEqual(base);
  });

  it("retains tombstones when an old checkpoint is replayed", () => {
    const { first, manifest, chunk } = fixture();
    resetDb();
    receive(first);
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "delete",
      fields: {},
    });
    begin(manifest);
    checkpoints.stageIncomingCheckpoint(
      manifest.producerDeviceId,
      manifest.checkpointId,
      chunk.records,
    );
    checkpoints.finishIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, noop);
    expect(journal.readSyncEntity(projectId, "project", projectId)).toBeNull();
  });

  it("enforces producer/allowlist and does not accept conflicting chunk replays", () => {
    const { manifest, chunk } = fixture();
    resetDb();
    expect(() =>
      checkpoints.beginIncomingCheckpoint("other-device", [projectId], manifest),
    ).toThrow(expect.objectContaining({ code: "stream_scope_mismatch" }));
    expect(() =>
      checkpoints.beginIncomingCheckpoint(manifest.producerDeviceId, [], manifest),
    ).toThrow(expect.objectContaining({ code: "stream_scope_mismatch" }));
    begin(manifest);
    checkpoints.stageIncomingCheckpoint(
      manifest.producerDeviceId,
      manifest.checkpointId,
      chunk.records,
    );
    const row = chunk.records.find((entry) => entry.record.field === "name")!;
    expect(() =>
      checkpoints.stageIncomingCheckpoint(manifest.producerDeviceId, manifest.checkpointId, [
        { ...row, record: { ...row.record, field: "rootPath" } },
      ]),
    ).toThrow(expect.objectContaining({ code: "invalid_checkpoint" }));
    expect(() => begin({ ...manifest, digest: "0".repeat(64) })).toThrow(
      expect.objectContaining({ code: "invalid_checkpoint" }),
    );
  });

  it("allows ACK of a sent checkpoint while retaining later outgoing deltas", () => {
    const { first, manifest } = fixture();
    journal.recordLocalSyncChange({
      projectId,
      entityId: projectId,
      entityType: "project",
      intent: "update",
      fields: { name: "After checkpoint" },
    });
    checkpoints.markSyncCheckpointSent("peer", manifest);
    journal.acknowledgeSyncOperations("peer", projectId, manifest.watermarks);
    expect(
      journal.listOutgoingSyncOperations(projectId, "peer").map((op) => op.originSequence),
    ).toEqual([2]);
    expect(manifest.watermarks[first.streamKey]).toBe(1);
  });
});
