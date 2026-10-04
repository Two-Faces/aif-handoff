import { z } from "zod";
import { TASK_STATUSES } from "../types.js";

export const SYNC_PROTOCOL_VERSION = 1;
export const MAX_SYNC_OPERATION_BYTES = 1_048_576;
export const MAX_SYNC_BATCH_OPERATIONS = 100;
const id = z.uuid();
const text = z.string().max(250_000);
const stamp = z.string().max(100);
const attribution = z.object({ id: id.nullable(), displayName: z.string().max(500) }).strict();
const attachment = z
  .object({
    name: z.string().max(500),
    mimeType: z.string().max(200),
    size: z.number().int().nonnegative(),
    content: z.null(),
  })
  .strict();

export const sharedProjectFields = z
  .object({
    name: z.string().min(1).max(500),
    groupName: z.string().max(500).nullable(),
    pinnedAt: stamp.nullable(),
    createdAt: stamp,
  })
  .strict();
export const sharedTaskFields = z
  .object({
    title: z.string().min(1).max(500),
    description: text,
    plan: text.nullable(),
    priority: z.number().int(),
    position: z.number().finite(),
    workflow: z
      .object({
        status: z.enum(TASK_STATUSES),
        executionOwner: z.enum(["ai", "human"]),
        ownershipRevision: z.number().int().nonnegative(),
        assignees: z.array(attribution.extend({ id })).max(100),
        blockedFromStatus: z.enum(TASK_STATUSES).nullable().default(null),
        manualReviewRequired: z.boolean().default(false),
        reworkRequested: z.boolean().default(false),
      })
      .strict(),
    attachments: z.array(attachment).max(100),
    tags: z.array(z.string().max(200)).max(100),
    isFix: z.boolean(),
    plannerMode: z.enum(["fast", "full"]),
    planDocs: z.boolean(),
    planTests: z.boolean(),
    skipReview: z.boolean(),
    useSubagents: z.boolean(),
    runPlanImprove: z.boolean(),
    runPostVerify: z.boolean(),
    implementationLog: text.nullable(),
    reviewComments: text.nullable(),
    roadmapAlias: z.string().max(500).nullable(),
    scheduledAt: stamp.nullable(),
    createdAt: stamp,
  })
  .strict();
export const sharedCommentFields = z
  .object({
    taskId: id,
    author: z.enum(["human", "agent"]),
    logicalAuthorId: id.nullable(),
    authorDisplayNameSnapshot: z.string().max(500).nullable(),
    message: text,
    attachments: z.array(attachment).max(100),
    createdAt: stamp,
  })
  .strict();
export const sharedHistoryFields = z
  .object({
    taskId: id,
    taskTitleSnapshot: text,
    ownershipRevision: z.number().int().nonnegative(),
    executionOwner: z.enum(["ai", "human"]),
    assignees: z.array(attribution).max(100),
    statusSnapshot: z.enum(TASK_STATUSES),
    actorKind: z.enum(["participant", "agent", "system", "anonymous"]),
    actor: attribution.nullable(),
    reason: text.nullable(),
    createdAt: stamp,
  })
  .strict();
export const sharedParticipantFields = z.object({ displayName: z.string().max(500) }).strict();
export const SHARED_ENTITY_SCHEMAS = {
  project: sharedProjectFields,
  task: sharedTaskFields,
  comment: sharedCommentFields,
  history: sharedHistoryFields,
  participant: sharedParticipantFields,
} as const;
export type SyncEntityType = keyof typeof SHARED_ENTITY_SCHEMAS;

export function syncStreamKey(projectId: string, deviceId: string, incarnation: string): string {
  return `${projectId}:${deviceId}:${incarnation}`;
}
const streamKey = z.string().refine((value) => {
  const parts = value.split(":");
  return parts.length === 3 && parts.every((part) => id.safeParse(part).success);
}, "Invalid stream key");
export const causalContextSchema = z
  .record(streamKey, z.number().int().nonnegative().safe())
  .refine((value) => Object.keys(value).length <= 4096, "Too many streams");
export const syncDotSchema = z
  .object({ streamKey, sequence: z.number().int().positive().safe() })
  .strict();
export const fieldVersionsSchema = z
  .array(
    z
      .object({
        dot: syncDotSchema,
        context: causalContextSchema,
        value: z.json(),
      })
      .strict(),
  )
  .min(1)
  .max(100);
const envelope = z.object({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  schemaVersion: z.literal(1),
  operationId: id,
  originDeviceId: id,
  deviceIncarnation: id,
  projectId: id,
  streamKey,
  originSequence: z.number().int().positive().safe(),
  entityId: id,
  intent: z.enum(["create", "update", "delete", "resolve"]),
  causalContext: causalContextSchema,
  actorKind: z.enum(["participant", "agent", "system", "anonymous"]),
  actor: attribution.nullable().optional(),
  parents: z.record(z.string().max(100), z.array(syncDotSchema).max(100)).optional(),
});
export const syncOperationSchema = z
  .discriminatedUnion("entityType", [
    envelope
      .extend({ entityType: z.literal("project"), fields: sharedProjectFields.partial() })
      .strict(),
    envelope.extend({ entityType: z.literal("task"), fields: sharedTaskFields.partial() }).strict(),
    envelope
      .extend({ entityType: z.literal("comment"), fields: sharedCommentFields.partial() })
      .strict(),
    envelope
      .extend({ entityType: z.literal("history"), fields: sharedHistoryFields.partial() })
      .strict(),
    envelope
      .extend({ entityType: z.literal("participant"), fields: sharedParticipantFields.partial() })
      .strict(),
  ])
  .superRefine((operation, ctx) => {
    const expected = syncStreamKey(
      operation.projectId,
      operation.originDeviceId,
      operation.deviceIncarnation,
    );
    if (operation.entityType === "project" && operation.entityId !== operation.projectId) {
      ctx.addIssue({ code: "custom", message: "Project entity scope mismatch" });
    }
    if (operation.streamKey !== expected)
      ctx.addIssue({ code: "custom", message: "Stream scope mismatch" });
    if (
      Object.keys(operation.causalContext).some((key) => !key.startsWith(`${operation.projectId}:`))
    ) {
      ctx.addIssue({ code: "custom", message: "Cross-project causal context" });
    }
    if ((operation.causalContext[expected] ?? 0) !== operation.originSequence - 1) {
      ctx.addIssue({ code: "custom", message: "Missing previous local sequence" });
    }
    if (
      operation.intent === "create" &&
      !SHARED_ENTITY_SCHEMAS[operation.entityType].safeParse(operation.fields).success
    ) {
      ctx.addIssue({ code: "custom", message: "Incomplete creation fields" });
    }
    if (operation.intent === "delete" && Object.keys(operation.fields).length > 0) {
      ctx.addIssue({ code: "custom", message: "Delete cannot carry edits" });
    }
    if (operation.intent !== "create" && "createdAt" in operation.fields) {
      ctx.addIssue({ code: "custom", message: "Creation time is immutable" });
    }
    if (operation.intent === "resolve" && !operation.parents) {
      ctx.addIssue({ code: "custom", message: "Resolution requires parents" });
    }
    if (operation.entityType === "history" && operation.intent !== "create") {
      ctx.addIssue({ code: "custom", message: "History is immutable" });
    }
    if (new TextEncoder().encode(JSON.stringify(operation)).byteLength > MAX_SYNC_OPERATION_BYTES) {
      ctx.addIssue({ code: "custom", message: "Operation too large" });
    }
  });
export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncDot = z.infer<typeof syncDotSchema>;
export type CausalContext = z.infer<typeof causalContextSchema>;
export type SyncRevisions = Record<string, SyncDot[]>;
export const syncRevisionsSchema = z
  .record(z.string().max(100), z.array(syncDotSchema).max(100))
  .refine((value) => Object.keys(value).length <= 64, "Too many revision fields");

export const checkpointRecordSchema = z
  .object({
    entityId: id,
    entityType: z.enum(["project", "task", "comment", "history", "participant"]),
    field: z.string().max(100),
    versions: fieldVersionsSchema,
  })
  .strict();
export const checkpointManifestSchema = z
  .object({
    protocolVersion: z.literal(1),
    schemaVersion: z.literal(1),
    checkpointId: id,
    projectId: id,
    producerDeviceId: id,
    watermarks: causalContextSchema,
    recordCount: z.number().int().nonnegative().max(1_000_000),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;
export const MAX_CHECKPOINT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;

export class SyncError extends Error {
  constructor(
    readonly code:
      | "invalid_operation"
      | "operation_collision"
      | "stream_scope_mismatch"
      | "sync_conflict_requires_resolution"
      | "resolution_changed"
      | "invalid_transition"
      | "entity_not_ready"
      | "invalid_checkpoint"
      | "invalid_ack"
      | "checkpoint_incomplete"
      | "sync_revision_required"
      | "sync_revision_conflict",
  ) {
    super(code);
    this.name = "SyncError";
  }
}
