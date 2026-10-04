import { z } from "zod";
import {
  causalContextSchema,
  checkpointManifestSchema,
  checkpointRecordSchema,
  peerIdentitySchema,
  syncOperationSchema,
  snapshotDigestSchema,
  taskDeviceHandoffOfferSchema,
} from "@aif/shared";

const scope = { projectId: z.uuid() };
const checkpoint = { ...scope, checkpointId: z.uuid() };
export const checkpointEntriesSchema = z
  .array(
    z.object({ ordinal: z.number().int().nonnegative(), record: checkpointRecordSchema }).strict(),
  )
  .max(100);
export const peerRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("handoffOffer"), offer: taskDeviceHandoffOfferSchema }).strict(),
  z.object({ kind: z.literal("handoffStatus"), ...scope, id: z.uuid() }).strict(),
  z
    .object({ kind: z.literal("snapshotManifest"), ...scope, snapshotId: snapshotDigestSchema })
    .strict(),
  z
    .object({
      kind: z.literal("snapshotChunk"),
      ...scope,
      snapshotId: snapshotDigestSchema,
      digest: snapshotDigestSchema,
      ordinal: z.number().int().min(0).max(255),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pair"),
      invitationId: z.uuid(),
      token: z.string().regex(/^[a-f0-9]{64}$/),
      identity: peerIdentitySchema,
      projectIds: z.array(z.uuid()).min(1).max(50),
    })
    .strict(),
  z.object({ kind: z.literal("hello") }).strict(),
  z.object({ kind: z.literal("resync"), ...scope }).strict(),
  z.object({ kind: z.literal("checkpointRequest"), ...scope }).strict(),
  z
    .object({
      kind: z.literal("checkpointRead"),
      ...checkpoint,
      from: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("checkpointOffer"), manifest: checkpointManifestSchema }).strict(),
  z
    .object({ kind: z.literal("checkpointStage"), ...checkpoint, entries: checkpointEntriesSchema })
    .strict(),
  z.object({ kind: z.literal("checkpointFinish"), ...checkpoint }).strict(),
  z
    .object({ kind: z.literal("checkpointAck"), ...checkpoint, watermarks: causalContextSchema })
    .strict(),
  z
    .object({
      kind: z.literal("exchange"),
      ...scope,
      operations: z.array(syncOperationSchema).max(100),
      ack: causalContextSchema,
    })
    .strict(),
]);
export const peerEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    schemaVersion: z.literal(1),
    deviceId: z.uuid(),
    request: peerRequestSchema,
  })
  .strict();
export type PeerRequest = z.infer<typeof peerRequestSchema>;
export const peerHelloSchema = z
  .object({ identity: peerIdentitySchema, projectIds: z.array(z.uuid()).max(50) })
  .strict();
export const peerExchangeSchema = z
  .object({
    operations: z.array(syncOperationSchema).max(100),
    watermarks: causalContextSchema,
    applied: z.number().int().nonnegative(),
  })
  .strict();
export const peerCheckpointChunkSchema = z
  .object({
    checkpointId: z.uuid(),
    from: z.number().int().nonnegative(),
    next: z.number().int().nonnegative(),
    records: checkpointEntriesSchema,
  })
  .strict();
export const peerCheckpointProgressSchema = z
  .object({ next: z.number().int().nonnegative(), complete: z.boolean() })
  .strict();
