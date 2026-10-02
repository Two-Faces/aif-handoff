import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import {
  canonicalJson,
  covers,
  dotKey,
  hasFieldConflict,
  mergeFieldVersions,
  fieldVersionsSchema,
  MAX_SYNC_BATCH_OPERATIONS,
  SyncError,
  syncFields,
  syncOperations,
  syncOperationSchema,
  syncPeerCursors,
  syncStreams,
  syncStreamKey,
  type CausalContext,
  type FieldVersion,
  type SyncDot,
  type SyncEntityType,
  type SyncOperation,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";

// A fresh writer process never reuses a sequence from a restored DB backup.
// API, MCP and worker processes share the DB but have distinct durable streams.
const writerIncarnation = randomUUID();
let remoteApplyDepth = 0;
export function isApplyingRemoteSync(): boolean {
  return remoteApplyDepth > 0;
}
export function runRemoteSyncProjection<T>(apply: () => T): T {
  remoteApplyDepth++;
  try {
    return apply();
  } finally {
    remoteApplyDepth--;
  }
}

const digest = (json: string) => createHash("sha256").update(json).digest("hex");
const entityWhere = (projectId: string, entityType: SyncEntityType, entityId: string) =>
  and(
    eq(syncFields.projectId, projectId),
    eq(syncFields.entityType, entityType),
    eq(syncFields.entityId, entityId),
  );

export function getSyncWatermarks(projectId: string): CausalContext {
  return Object.fromEntries(
    getDb()
      .select()
      .from(syncStreams)
      .where(eq(syncStreams.projectId, projectId))
      .all()
      .filter((stream) => stream.appliedSequence > 0)
      .map((stream) => [stream.streamKey, stream.appliedSequence]),
  );
}

export function readSyncVersions(
  projectId: string,
  entityType: SyncEntityType,
  entityId: string,
): Record<string, FieldVersion[]> {
  const rows = getDb()
    .select()
    .from(syncFields)
    .where(entityWhere(projectId, entityType, entityId))
    .all();
  return Object.fromEntries(
    rows.map((row) => [row.field, fieldVersionsSchema.parse(JSON.parse(row.versionsJson))]),
  );
}

export function readSyncEntity(
  projectId: string,
  entityType: SyncEntityType,
  entityId: string,
): Record<string, unknown> | null {
  const versions = readSyncVersions(projectId, entityType, entityId);
  if (!versions.__created || versions.__deleted) return null;
  return Object.fromEntries(
    Object.entries(versions)
      .filter(([field]) => !field.startsWith("__"))
      .map(([field, values]) => [field, values[0]?.value]),
  );
}

export function listSyncConflicts(
  projectId: string,
): Array<{ entityType: string; entityId: string; field: string; versions: FieldVersion[] }> {
  return getDb()
    .select()
    .from(syncFields)
    .where(eq(syncFields.projectId, projectId))
    .all()
    .flatMap((row) => {
      const versions = fieldVersionsSchema.parse(JSON.parse(row.versionsJson));
      if (row.field.startsWith("__") || row.field === "position" || !hasFieldConflict(versions))
        return [];
      return [{ entityType: row.entityType, entityId: row.entityId, field: row.field, versions }];
    });
}

function parseOperation(value: unknown): SyncOperation {
  const result = syncOperationSchema.safeParse(value);
  if (!result.success) throw new SyncError("invalid_operation");
  return result.data;
}

function ensureStream(operation: SyncOperation) {
  getDb()
    .insert(syncStreams)
    .values({
      streamKey: operation.streamKey,
      projectId: operation.projectId,
      originDeviceId: operation.originDeviceId,
      incarnation: operation.deviceIncarnation,
    })
    .onConflictDoNothing()
    .run();
}

function storeOperation(operation: SyncOperation, outgoing: boolean): boolean {
  const json = canonicalJson(operation);
  const hash = digest(json);
  const existing = getDb()
    .select()
    .from(syncOperations)
    .where(
      or(
        eq(syncOperations.operationId, operation.operationId),
        and(
          eq(syncOperations.streamKey, operation.streamKey),
          eq(syncOperations.sequence, operation.originSequence),
        ),
      ),
    )
    .get();
  if (existing) {
    if (existing.digest !== hash) throw new SyncError("operation_collision");
    return false;
  }
  ensureStream(operation);
  getDb()
    .insert(syncOperations)
    .values({
      operationId: operation.operationId,
      projectId: operation.projectId,
      streamKey: operation.streamKey,
      sequence: operation.originSequence,
      json,
      digest: hash,
      outgoing,
      applied: false,
    })
    .run();
  return true;
}

function canApply(operation: SyncOperation): boolean {
  const watermarks = getSyncWatermarks(operation.projectId);
  return (
    (watermarks[operation.streamKey] ?? 0) === operation.originSequence - 1 &&
    Object.entries(operation.causalContext).every(
      ([stream, sequence]) => (watermarks[stream] ?? 0) >= sequence,
    )
  );
}

function writeField(
  projectId: string,
  entityType: SyncEntityType,
  entityId: string,
  field: string,
  versions: FieldVersion[],
) {
  const versionsJson = canonicalJson(versions);
  getDb()
    .insert(syncFields)
    .values({ projectId, entityType, entityId, field, versionsJson })
    .onConflictDoUpdate({
      target: [syncFields.projectId, syncFields.entityType, syncFields.entityId, syncFields.field],
      set: { versionsJson },
    })
    .run();
}

function applyRegisters(operation: SyncOperation): void {
  const current = readSyncVersions(operation.projectId, operation.entityType, operation.entityId);
  if (
    operation.entityType === "history" &&
    current.__created &&
    canonicalJson(readSyncEntity(operation.projectId, operation.entityType, operation.entityId)) !==
      canonicalJson(operation.fields)
  ) {
    throw new SyncError("operation_collision");
  }
  if (
    operation.entityType === "task" &&
    operation.fields.workflow &&
    operation.actorKind === "agent"
  ) {
    const knownHumanOwner = (current.workflow ?? []).some(
      (version) =>
        covers(operation.causalContext, version.dot) &&
        version.value !== null &&
        typeof version.value === "object" &&
        !Array.isArray(version.value) &&
        "executionOwner" in version.value &&
        version.value.executionOwner === "human",
    );
    if (knownHumanOwner) throw new SyncError("invalid_transition");
  }
  if (operation.intent !== "create" && operation.intent !== "delete" && !current.__created) {
    throw new SyncError("entity_not_ready");
  }
  const fields: Record<string, unknown> = { ...operation.fields };
  if (operation.intent === "create") fields.__created = true;
  if (operation.intent === "delete") fields.__deleted = true;
  const dot: SyncDot = { streamKey: operation.streamKey, sequence: operation.originSequence };
  for (const [field, value] of Object.entries(fields)) {
    const parents = operation.parents?.[field];
    if (operation.intent === "resolve") {
      if (!parents?.length || parents.some((parent) => !covers(operation.causalContext, parent))) {
        throw new SyncError("invalid_operation");
      }
    }
    const merged = mergeFieldVersions([
      ...(current[field] ?? []),
      { dot, context: operation.causalContext, value },
    ]);
    writeField(operation.projectId, operation.entityType, operation.entityId, field, merged);
  }
  getDb()
    .update(syncOperations)
    .set({ applied: true })
    .where(eq(syncOperations.operationId, operation.operationId))
    .run();
  getDb()
    .update(syncStreams)
    .set({ appliedSequence: operation.originSequence })
    .where(eq(syncStreams.streamKey, operation.streamKey))
    .run();
}

export interface LocalSyncChange {
  projectId: string;
  entityType: SyncEntityType;
  entityId: string;
  intent: SyncOperation["intent"];
  fields: Record<string, unknown>;
  actorKind?: SyncOperation["actorKind"];
  parents?: Record<string, SyncDot[]>;
}

/** Called inside the domain transaction. Projection and journal share rollback. */
export function recordLocalSyncChange(change: LocalSyncChange): SyncOperation | null {
  if (isApplyingRemoteSync()) return null;
  return getDb().transaction(() => {
    const current = readSyncVersions(change.projectId, change.entityType, change.entityId);
    if (current.__deleted && change.intent !== "delete") throw new SyncError("invalid_transition");
    for (const field of Object.keys(change.fields)) {
      const versions = current[field] ?? [];
      if (change.intent === "resolve") {
        const expected = (change.parents?.[field] ?? []).map(dotKey).sort();
        const actual = versions.map((version) => dotKey(version.dot)).sort();
        if (!expected.length || canonicalJson(expected) !== canonicalJson(actual))
          throw new SyncError("resolution_changed");
      } else if (field !== "position" && hasFieldConflict(versions)) {
        throw new SyncError("sync_conflict_requires_resolution");
      }
    }
    const { deviceId } = getLocalDevice();
    const streamKey = syncStreamKey(change.projectId, deviceId, writerIncarnation);
    const stream = getDb()
      .select()
      .from(syncStreams)
      .where(eq(syncStreams.streamKey, streamKey))
      .get();
    const sequence = stream?.nextSequence ?? 1;
    const operation = parseOperation({
      protocolVersion: 1,
      schemaVersion: 1,
      operationId: randomUUID(),
      originDeviceId: deviceId,
      deviceIncarnation: writerIncarnation,
      projectId: change.projectId,
      streamKey,
      originSequence: sequence,
      entityType: change.entityType,
      entityId: change.entityId,
      intent: change.intent,
      fields: change.fields,
      actorKind: change.actorKind ?? "system",
      causalContext: getSyncWatermarks(change.projectId),
      ...(change.parents ? { parents: change.parents } : {}),
    });
    storeOperation(operation, true);
    applyRegisters(operation);
    getDb()
      .update(syncStreams)
      .set({ nextSequence: sequence + 1 })
      .where(eq(syncStreams.streamKey, streamKey))
      .run();
    return operation;
  });
}

export type SyncEntityRef = Pick<SyncOperation, "projectId" | "entityType" | "entityId">;
export type SyncProjectionWriter = (
  entity: SyncEntityRef,
  fields: Record<string, unknown> | null,
) => void;

/** ACK is the returned committed watermark; callers must send it only after return. */
export function receiveSyncOperations(
  input: {
    peerDeviceId: string;
    allowedProjectIds: readonly string[];
    operations: readonly unknown[];
  },
  project: SyncProjectionWriter,
) {
  if (input.operations.length > MAX_SYNC_BATCH_OPERATIONS) throw new SyncError("invalid_operation");
  const operations = input.operations.map(parseOperation);
  for (const operation of operations) {
    if (
      operation.originDeviceId !== input.peerDeviceId ||
      !input.allowedProjectIds.includes(operation.projectId)
    ) {
      throw new SyncError("stream_scope_mismatch");
    }
  }
  return getDb().transaction(() => {
    remoteApplyDepth++;
    try {
      let accepted = 0;
      let applied = 0;
      for (const operation of operations) if (storeOperation(operation, false)) accepted++;
      let progress = true;
      while (progress) {
        progress = false;
        for (const projectId of input.allowedProjectIds) {
          const pending = getDb()
            .select({ json: syncOperations.json })
            .from(syncOperations)
            .innerJoin(syncStreams, eq(syncStreams.streamKey, syncOperations.streamKey))
            .where(
              and(
                eq(syncOperations.projectId, projectId),
                eq(syncOperations.applied, false),
                eq(syncOperations.sequence, sql<number>`${syncStreams.appliedSequence} + 1`),
              ),
            )
            .orderBy(asc(syncOperations.streamKey), asc(syncOperations.sequence))
            .all();
          for (const row of pending) {
            const operation = parseOperation(JSON.parse(row.json));
            if (!canApply(operation)) continue;
            applyRegisters(operation);
            const projectionResult: unknown = project(
              operation,
              readSyncEntity(projectId, operation.entityType, operation.entityId),
            );
            if (projectionResult !== undefined) throw new SyncError("invalid_transition");
            progress = true;
            applied++;
          }
        }
      }
      return {
        accepted,
        applied,
        watermarks: Object.fromEntries(
          input.allowedProjectIds.map((id) => [id, getSyncWatermarks(id)]),
        ),
      };
    } finally {
      remoteApplyDepth--;
    }
  });
}

export function listOutgoingSyncOperations(
  projectId: string,
  peerId: string,
  limit = MAX_SYNC_BATCH_OPERATIONS,
): SyncOperation[] {
  const size = Math.max(1, Math.min(limit, MAX_SYNC_BATCH_OPERATIONS));
  return getDb()
    .select({ json: syncOperations.json })
    .from(syncOperations)
    .leftJoin(
      syncPeerCursors,
      and(
        eq(syncPeerCursors.streamKey, syncOperations.streamKey),
        eq(syncPeerCursors.peerId, peerId),
      ),
    )
    .where(
      and(
        eq(syncOperations.projectId, projectId),
        eq(syncOperations.outgoing, true),
        gt(syncOperations.sequence, sql<number>`coalesce(${syncPeerCursors.ackSequence}, 0)`),
      ),
    )
    .orderBy(asc(syncOperations.streamKey), asc(syncOperations.sequence))
    .limit(size)
    .all()
    .map((row) => parseOperation(JSON.parse(row.json)));
}

export function markSyncOperationsSent(peerId: string, operations: readonly SyncOperation[]): void {
  getDb().transaction(() => {
    for (const operation of operations) {
      const stored = getDb()
        .select()
        .from(syncOperations)
        .where(eq(syncOperations.operationId, operation.operationId))
        .get();
      if (!stored?.outgoing || stored.digest !== digest(canonicalJson(operation)))
        throw new SyncError("invalid_ack");
      const previous = getDb()
        .select()
        .from(syncPeerCursors)
        .where(
          and(
            eq(syncPeerCursors.peerId, peerId),
            eq(syncPeerCursors.streamKey, operation.streamKey),
          ),
        )
        .get();
      if (operation.originSequence > (previous?.sentSequence ?? 0) + 1)
        throw new SyncError("invalid_ack");
      getDb()
        .insert(syncPeerCursors)
        .values({ peerId, streamKey: operation.streamKey, sentSequence: operation.originSequence })
        .onConflictDoUpdate({
          target: [syncPeerCursors.peerId, syncPeerCursors.streamKey],
          set: {
            sentSequence: sql`max(${syncPeerCursors.sentSequence}, ${operation.originSequence})`,
          },
        })
        .run();
    }
  });
}

export function acknowledgeSyncOperations(
  peerId: string,
  projectId: string,
  watermarks: CausalContext,
): void {
  getDb().transaction(() => {
    for (const [stream, sequence] of Object.entries(watermarks)) {
      if (!stream.startsWith(`${projectId}:`) || !Number.isSafeInteger(sequence) || sequence < 0)
        throw new SyncError("invalid_ack");
      const cursor = getDb()
        .select()
        .from(syncPeerCursors)
        .where(and(eq(syncPeerCursors.peerId, peerId), eq(syncPeerCursors.streamKey, stream)))
        .get();
      if (!cursor || sequence > cursor.sentSequence || sequence < cursor.ackSequence)
        throw new SyncError("invalid_ack");
      getDb()
        .update(syncPeerCursors)
        .set({ ackSequence: sequence })
        .where(and(eq(syncPeerCursors.peerId, peerId), eq(syncPeerCursors.streamKey, stream)))
        .run();
    }
  });
}
