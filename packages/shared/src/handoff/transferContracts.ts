import { z } from "zod";
import {
  codeSnapshotDescriptorSchema,
  contextManifestSchema,
  gitObjectIdSchema,
  snapshotDigestSchema,
  type CodeSnapshotPackage,
} from "./contracts.js";
import { snapshotDigest } from "./contextSnapshot.js";

export const SNAPSHOT_CHUNK_BYTES = 256 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_TRANSFER_BYTES = 2 * MAX_BUNDLE_BYTES + 8 * 1024 * 1024;
export class SnapshotTransferError extends Error {
  constructor(
    readonly code:
      | "snapshot_invalid"
      | "snapshot_missing"
      | "snapshot_quota"
      | "snapshot_incomplete"
      | "snapshot_conflict"
      | "snapshot_base_missing"
      | "snapshot_format_mismatch"
      | "snapshot_unsupported_code"
      | "snapshot_checkout_changed"
      | "snapshot_binding_missing"
      | "snapshot_cancelled",
    message = code,
  ) {
    super(message);
    this.name = "SnapshotTransferError";
  }
}
export const snapshotResourceSchema = z
  .object({
    digest: snapshotDigestSchema,
    size: z.number().int().min(0).max(MAX_BUNDLE_BYTES),
    chunks: z.array(snapshotDigestSchema).max(MAX_BUNDLE_BYTES / SNAPSHOT_CHUNK_BYTES),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.chunks.length !== Math.ceil(value.size / SNAPSHOT_CHUNK_BYTES))
      ctx.addIssue({ code: "custom", message: "Invalid chunk count" });
  });
export const snapshotTransferManifestSchema = z
  .object({
    version: z.literal(1),
    snapshotId: snapshotDigestSchema,
    descriptor: codeSnapshotDescriptorSchema,
    context: contextManifestSchema,
    fullBundle: snapshotResourceSchema,
    incrementalBundle: z
      .object({ baseCommit: gitObjectIdSchema, resource: snapshotResourceSchema })
      .strict()
      .nullable(),
    contextBlobs: z.array(snapshotResourceSchema).max(512),
  })
  .strict();
export type SnapshotTransferManifest = z.infer<typeof snapshotTransferManifestSchema>;
export type SnapshotResource = z.infer<typeof snapshotResourceSchema>;
export function snapshotResources(manifest: SnapshotTransferManifest): SnapshotResource[] {
  return [
    manifest.fullBundle,
    ...(manifest.incrementalBundle ? [manifest.incrementalBundle.resource] : []),
    ...manifest.contextBlobs,
  ];
}
export function verifySnapshotTransferManifest(value: unknown): SnapshotTransferManifest {
  const parsed = snapshotTransferManifestSchema.safeParse(value);
  if (!parsed.success) throw new SnapshotTransferError("snapshot_invalid");
  const manifest = parsed.data;
  const { descriptor, context } = manifest;
  const resources = snapshotResources(manifest);
  const files = new Map(context.files.map((file) => [file.digest, file.size]));
  if (
    Buffer.byteLength(JSON.stringify(manifest)) > 2 * 1024 * 1024 ||
    manifest.snapshotId !== snapshotDigest(descriptor) ||
    descriptor.contextDigest !== snapshotDigest(context) ||
    descriptor.projectId !== context.projectId ||
    descriptor.taskId !== context.taskId ||
    descriptor.commitSha !== context.commitSha ||
    context.plan.revision !== snapshotDigest({ text: context.plan.text }) ||
    (manifest.incrementalBundle &&
      (manifest.incrementalBundle.baseCommit !== descriptor.baseCommit ||
        descriptor.baseCommit === descriptor.commitSha)) ||
    new Set(resources.map((resource) => resource.digest)).size !== resources.length ||
    resources.reduce((sum, resource) => sum + resource.size, 0) > MAX_TRANSFER_BYTES ||
    manifest.contextBlobs.length !== files.size ||
    manifest.fullBundle.size === 0 ||
    manifest.contextBlobs.some((resource) => files.get(resource.digest) !== resource.size) ||
    context.files.some((file) => files.get(file.digest) !== file.size)
  )
    throw new SnapshotTransferError("snapshot_invalid");
  return manifest;
}
export function snapshotPackageFromResources(
  manifest: SnapshotTransferManifest,
  read: (resource: SnapshotResource) => Buffer,
): CodeSnapshotPackage {
  return {
    id: manifest.snapshotId,
    descriptor: manifest.descriptor,
    context: manifest.context,
    blobs: manifest.contextBlobs.map((resource) => ({
      digest: resource.digest,
      base64: read(resource).toString("base64"),
    })),
  };
}
export const snapshotChunkReplySchema = z
  .object({
    digest: snapshotDigestSchema,
    ordinal: z.number().int().nonnegative(),
    base64: z.string().max(Math.ceil(SNAPSHOT_CHUNK_BYTES / 3) * 4),
  })
  .strict();
