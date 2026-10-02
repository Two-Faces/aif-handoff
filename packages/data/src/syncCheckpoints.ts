import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, eq, gte, lte, sql } from "drizzle-orm";
import {
  canonicalJson,
  checkpointManifestSchema,
  checkpointRecordSchema,
  mergeFieldVersions,
  MAX_CHECKPOINT_BYTES,
  MAX_CHECKPOINT_CHUNK_BYTES,
  SHARED_ENTITY_SCHEMAS,
  SyncError,
  syncCheckpointRecords,
  syncCheckpoints,
  syncFields,
  syncOperations,
  syncPeerCursors,
  syncStreams,
  type CheckpointManifest,
  type CheckpointRecord,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import {
  getSyncWatermarks,
  readSyncEntity,
  readSyncVersions,
  runRemoteSyncProjection,
  type SyncProjectionWriter,
} from "./syncJournal.js";

const cpWhere = (id: string) => eq(syncCheckpoints.checkpointId, id);
const partWhere = (id: string) => eq(syncCheckpointRecords.checkpointId, id);
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

function checkpoint(id: string) {
  const row = getDb().select().from(syncCheckpoints).where(cpWhere(id)).get();
  if (!row) throw new SyncError("invalid_checkpoint");
  return row;
}

function manifestOf(row: ReturnType<typeof checkpoint>): CheckpointManifest {
  return checkpointManifestSchema.parse({
    protocolVersion: 1,
    schemaVersion: 1,
    checkpointId: row.checkpointId,
    projectId: row.projectId,
    producerDeviceId: row.producerDeviceId,
    watermarks: JSON.parse(row.watermarksJson),
    recordCount: row.recordCount,
    digest: row.digest,
  });
}

function* records(id: string) {
  let from = 0;
  while (true) {
    const rows = getDb()
      .select()
      .from(syncCheckpointRecords)
      .where(and(partWhere(id), gte(syncCheckpointRecords.ordinal, from)))
      .orderBy(asc(syncCheckpointRecords.ordinal))
      .limit(16)
      .all();
    if (!rows.length) return;
    for (const row of rows) {
      yield row;
      from = row.ordinal + 1;
    }
  }
}

function checkpointDigest(id: string): string {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of records(id)) {
    bytes += byteLength(row.json);
    if (bytes > MAX_CHECKPOINT_BYTES) throw new SyncError("invalid_checkpoint");
    hash.update(row.json).update("\n");
  }
  return hash.digest("hex");
}

/** Snapshot rows and watermarks in one transaction, then stream the immutable copy. */
export function createSyncCheckpoint(projectId: string): CheckpointManifest {
  const checkpointId = randomUUID();
  getDb().transaction((tx) => {
    const root = readSyncVersions(projectId, "project", projectId);
    if (!root.__created && !root.__deleted) throw new SyncError("entity_not_ready");
    tx.insert(syncCheckpoints)
      .values({
        checkpointId,
        projectId,
        producerDeviceId: getLocalDevice().deviceId,
        watermarksJson: canonicalJson(getSyncWatermarks(projectId)),
        recordCount: 0,
        received: false,
      })
      .run();
    tx.run(sql`INSERT INTO ${syncCheckpointRecords} (checkpoint_id, ordinal, json)
      SELECT ${checkpointId}, row_number() OVER (ORDER BY entity_type, entity_id, field) - 1,
        json_object('entityId', entity_id, 'entityType', entity_type, 'field', field, 'versions', json(versions_json))
      FROM ${syncFields} WHERE project_id = ${projectId}`);
    const total =
      tx.select({ value: count() }).from(syncCheckpointRecords).where(partWhere(checkpointId)).get()
        ?.value ?? 0;
    if (total > 1_000_000) throw new SyncError("invalid_checkpoint");
    const bytes =
      tx
        .select({
          value: sql<number>`coalesce(sum(length(cast(${syncCheckpointRecords.json} as blob))), 0)`,
        })
        .from(syncCheckpointRecords)
        .where(partWhere(checkpointId))
        .get()?.value ?? 0;
    if (bytes > MAX_CHECKPOINT_BYTES) throw new SyncError("invalid_checkpoint");
    tx.update(syncCheckpoints)
      .set({ recordCount: total, nextOrdinal: total })
      .where(cpWhere(checkpointId))
      .run();
  });
  const digest = checkpointDigest(checkpointId);
  getDb()
    .update(syncCheckpoints)
    .set({ digest, complete: true })
    .where(cpWhere(checkpointId))
    .run();
  return manifestOf(checkpoint(checkpointId));
}

export function readSyncCheckpointChunk(checkpointId: string, from: number) {
  const cp = checkpoint(checkpointId);
  if (
    !cp.complete ||
    cp.received ||
    !Number.isSafeInteger(from) ||
    from < 0 ||
    from > cp.recordCount
  ) {
    throw new SyncError("invalid_checkpoint");
  }
  const result: Array<{ ordinal: number; record: CheckpointRecord }> = [];
  let bytes = 2;
  const rows = getDb()
    .select()
    .from(syncCheckpointRecords)
    .where(and(partWhere(checkpointId), gte(syncCheckpointRecords.ordinal, from)))
    .orderBy(asc(syncCheckpointRecords.ordinal))
    .limit(100)
    .all();
  for (const row of rows) {
    const entry = {
      ordinal: row.ordinal,
      record: checkpointRecordSchema.parse(JSON.parse(row.json)),
    };
    const size = byteLength(JSON.stringify(entry)) + (result.length > 0 ? 1 : 0);
    if (size + 2 > MAX_CHECKPOINT_CHUNK_BYTES) throw new SyncError("invalid_checkpoint");
    if (bytes + size > MAX_CHECKPOINT_CHUNK_BYTES) break;
    bytes += size;
    result.push(entry);
  }
  return { checkpointId, from, next: from + result.length, records: result };
}

export function beginIncomingCheckpoint(
  peerDeviceId: string,
  allowedProjectIds: readonly string[],
  input: unknown,
) {
  const parsed = checkpointManifestSchema.safeParse(input);
  if (!parsed.success) throw new SyncError("invalid_checkpoint");
  const manifest = parsed.data;
  if (
    manifest.producerDeviceId !== peerDeviceId ||
    !allowedProjectIds.includes(manifest.projectId) ||
    Object.keys(manifest.watermarks).some((key) => !key.startsWith(`${manifest.projectId}:`))
  ) {
    throw new SyncError("stream_scope_mismatch");
  }
  return getDb().transaction((tx) => {
    const previous = tx.select().from(syncCheckpoints).where(cpWhere(manifest.checkpointId)).get();
    if (previous) {
      if (!previous.received || canonicalJson(manifestOf(previous)) !== canonicalJson(manifest))
        throw new SyncError("invalid_checkpoint");
      return { next: previous.nextOrdinal, complete: previous.complete };
    }
    tx.insert(syncCheckpoints)
      .values({
        checkpointId: manifest.checkpointId,
        projectId: manifest.projectId,
        producerDeviceId: peerDeviceId,
        watermarksJson: canonicalJson(manifest.watermarks),
        recordCount: manifest.recordCount,
        digest: manifest.digest,
        received: true,
      })
      .run();
    return { next: 0, complete: false };
  });
}

function validateRecord(input: unknown, manifest: CheckpointManifest): CheckpointRecord {
  const parsed = checkpointRecordSchema.safeParse(input);
  if (!parsed.success) throw new SyncError("invalid_checkpoint");
  const record = parsed.data;
  if (record.entityType === "project" && record.entityId !== manifest.projectId)
    throw new SyncError("invalid_checkpoint");
  const shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }> =
    SHARED_ENTITY_SCHEMAS[record.entityType].shape;
  const internal = record.field === "__created" || record.field === "__deleted";
  if (!internal && !Object.hasOwn(shape, record.field)) throw new SyncError("invalid_checkpoint");
  for (const version of record.versions) {
    const dot = version.dot;
    if (
      !dot.streamKey.startsWith(`${manifest.projectId}:`) ||
      (manifest.watermarks[dot.streamKey] ?? 0) < dot.sequence ||
      (version.context[dot.streamKey] ?? 0) !== dot.sequence - 1 ||
      Object.entries(version.context).some(
        ([key, seq]) =>
          !key.startsWith(`${manifest.projectId}:`) || (manifest.watermarks[key] ?? 0) < seq,
      ) ||
      (internal ? version.value !== true : !shape[record.field]!.safeParse(version.value).success)
    ) {
      throw new SyncError("invalid_checkpoint");
    }
  }
  return record;
}

export function stageIncomingCheckpoint(
  peerDeviceId: string,
  checkpointId: string,
  chunk: readonly { ordinal: number; record: unknown }[],
) {
  const cp = checkpoint(checkpointId);
  if (
    !cp.received ||
    cp.producerDeviceId !== peerDeviceId ||
    chunk.length > 100 ||
    byteLength(JSON.stringify(chunk)) > MAX_CHECKPOINT_CHUNK_BYTES
  ) {
    throw new SyncError("invalid_checkpoint");
  }
  const manifest = manifestOf(cp);
  return getDb().transaction((tx) => {
    let receivedBytes = cp.receivedBytes;
    for (const item of chunk) {
      if (!Number.isSafeInteger(item.ordinal) || item.ordinal < 0 || item.ordinal >= cp.recordCount)
        throw new SyncError("invalid_checkpoint");
      const json = canonicalJson(validateRecord(item.record, manifest));
      const previous = tx
        .select()
        .from(syncCheckpointRecords)
        .where(and(partWhere(checkpointId), eq(syncCheckpointRecords.ordinal, item.ordinal)))
        .get();
      if (previous && previous.json !== json) throw new SyncError("invalid_checkpoint");
      if (!previous) {
        receivedBytes += byteLength(json);
        if (receivedBytes > MAX_CHECKPOINT_BYTES) throw new SyncError("invalid_checkpoint");
        tx.insert(syncCheckpointRecords)
          .values({ checkpointId, ordinal: item.ordinal, json })
          .run();
      }
    }
    let next = cp.nextOrdinal;
    while (next < cp.recordCount) {
      const row = tx
        .select({ ordinal: syncCheckpointRecords.ordinal })
        .from(syncCheckpointRecords)
        .where(and(partWhere(checkpointId), eq(syncCheckpointRecords.ordinal, next)))
        .get();
      if (!row) break;
      next++;
    }
    tx.update(syncCheckpoints)
      .set({ nextOrdinal: next, receivedBytes })
      .where(cpWhere(checkpointId))
      .run();
    return { next, complete: cp.complete };
  });
}

export function finishIncomingCheckpoint(
  peerDeviceId: string,
  checkpointId: string,
  project: SyncProjectionWriter,
) {
  return getDb().transaction((tx) =>
    runRemoteSyncProjection(() => {
      const cp = checkpoint(checkpointId);
      if (!cp.received || cp.producerDeviceId !== peerDeviceId)
        throw new SyncError("invalid_checkpoint");
      if (cp.complete) return getSyncWatermarks(cp.projectId);
      if (cp.nextOrdinal !== cp.recordCount) throw new SyncError("checkpoint_incomplete");
      if (checkpointDigest(checkpointId) !== cp.digest) throw new SyncError("invalid_checkpoint");
      const manifest = manifestOf(cp);
      let containsRoot = false;
      for (const row of records(checkpointId)) {
        const record = validateRecord(JSON.parse(row.json), manifest);
        if (
          record.entityType === "project" &&
          (record.field === "__created" || record.field === "__deleted")
        )
          containsRoot = true;
        const current =
          readSyncVersions(cp.projectId, record.entityType, record.entityId)[record.field] ?? [];
        const merged = mergeFieldVersions([...current, ...record.versions]);
        if (!merged.length) throw new SyncError("invalid_checkpoint");
        const values = {
          projectId: cp.projectId,
          entityType: record.entityType,
          entityId: record.entityId,
          field: record.field,
          versionsJson: canonicalJson(merged),
        };
        tx.insert(syncFields)
          .values(values)
          .onConflictDoUpdate({
            target: [
              syncFields.projectId,
              syncFields.entityType,
              syncFields.entityId,
              syncFields.field,
            ],
            set: { versionsJson: values.versionsJson },
          })
          .run();
      }
      if (!containsRoot) throw new SyncError("invalid_checkpoint");
      for (const entityType of ["project", "participant", "task", "comment", "history"] as const) {
        const entities = tx
          .selectDistinct({ entityId: syncFields.entityId })
          .from(syncFields)
          .where(and(eq(syncFields.projectId, cp.projectId), eq(syncFields.entityType, entityType)))
          .all();
        for (const entity of entities) {
          const value: unknown = project(
            { projectId: cp.projectId, entityType, entityId: entity.entityId },
            readSyncEntity(cp.projectId, entityType, entity.entityId),
          );
          if (value !== undefined) throw new SyncError("invalid_transition");
        }
      }
      for (const [streamKey, sequence] of Object.entries(manifest.watermarks)) {
        const [, originDeviceId, incarnation] = streamKey.split(":") as [string, string, string];
        tx.insert(syncStreams)
          .values({
            streamKey,
            projectId: cp.projectId,
            originDeviceId,
            incarnation,
            appliedSequence: sequence,
            nextSequence: sequence + 1,
          })
          .onConflictDoUpdate({
            target: syncStreams.streamKey,
            set: {
              appliedSequence: sql`max(${syncStreams.appliedSequence}, ${sequence})`,
              nextSequence: sql`max(${syncStreams.nextSequence}, ${sequence + 1})`,
            },
          })
          .run();
        tx.update(syncOperations)
          .set({ applied: true })
          .where(
            and(eq(syncOperations.streamKey, streamKey), lte(syncOperations.sequence, sequence)),
          )
          .run();
      }
      tx.update(syncCheckpoints).set({ complete: true }).where(cpWhere(checkpointId)).run();
      return getSyncWatermarks(cp.projectId);
    }),
  );
}

export function markSyncCheckpointSent(peerId: string, manifest: CheckpointManifest): void {
  const cp = checkpoint(manifest.checkpointId);
  if (!cp.complete || cp.received || canonicalJson(manifestOf(cp)) !== canonicalJson(manifest))
    throw new SyncError("invalid_checkpoint");
  const { deviceId } = getLocalDevice();
  getDb().transaction((tx) => {
    for (const [streamKey, sequence] of Object.entries(manifest.watermarks)) {
      if (streamKey.split(":")[1] !== deviceId) continue;
      tx.insert(syncPeerCursors)
        .values({ peerId, streamKey, sentSequence: sequence })
        .onConflictDoUpdate({
          target: [syncPeerCursors.peerId, syncPeerCursors.streamKey],
          set: { sentSequence: sql`max(${syncPeerCursors.sentSequence}, ${sequence})` },
        })
        .run();
    }
  });
}
