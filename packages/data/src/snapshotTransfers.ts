import { and, eq, sql } from "drizzle-orm";
import { isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { getDb } from "@aif/shared/server";
import {
  canonicalJson,
  contextBlobDigest,
  codeSnapshotLocations,
  projectCheckouts,
  snapshotChunks,
  snapshotExports,
  snapshotTransfers,
  tasks,
  SNAPSHOT_CHUNK_BYTES,
  SnapshotTransferError,
  snapshotResources,
  verifySnapshotTransferManifest,
  type SnapshotResource,
  type SnapshotTransferManifest,
} from "@aif/shared";
import { getLocalDevice } from "./devices.js";
import { requirePeerProject } from "./peers.js";
import { loadCodeSnapshotPackage } from "./codeSnapshots.js";

const STORAGE_LIMIT = 512 * 1024 * 1024;
const owner = (id: string, outgoing = false) => `${outgoing ? "export" : "incoming"}:${id}`;
export function describeSnapshotResource(bytes: Buffer): SnapshotResource {
  const chunks: string[] = [];
  for (let from = 0; from < bytes.length; from += SNAPSHOT_CHUNK_BYTES)
    chunks.push(contextBlobDigest(bytes.subarray(from, from + SNAPSHOT_CHUNK_BYTES)));
  return { digest: contextBlobDigest(bytes), size: bytes.length, chunks };
}
function checkChunk(resource: SnapshotResource, ordinal: number, base64: string): Buffer {
  if (
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= resource.chunks.length ||
    base64.length > Math.ceil(SNAPSHOT_CHUNK_BYTES / 3) * 4
  )
    throw new SnapshotTransferError("snapshot_invalid");
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.toString("base64") !== base64 ||
    bytes.length !==
      Math.min(SNAPSHOT_CHUNK_BYTES, resource.size - ordinal * SNAPSHOT_CHUNK_BYTES) ||
    contextBlobDigest(bytes) !== resource.chunks[ordinal]
  )
    throw new SnapshotTransferError("snapshot_invalid");
  return bytes;
}
function writeChunk(ownerId: string, resource: SnapshotResource, ordinal: number, base64: string) {
  checkChunk(resource, ordinal, base64);
  const db = getDb();
  const existing = db
    .select()
    .from(snapshotChunks)
    .where(
      and(
        eq(snapshotChunks.ownerId, ownerId),
        eq(snapshotChunks.digest, resource.digest),
        eq(snapshotChunks.ordinal, ordinal),
      ),
    )
    .get();
  if (existing && existing.base64 !== base64) throw new SnapshotTransferError("snapshot_conflict");
  if (!existing)
    db.insert(snapshotChunks).values({ ownerId, digest: resource.digest, ordinal, base64 }).run();
}
export function getSnapshotExportSource(projectId: string, snapshotId: string) {
  const pack = loadCodeSnapshotPackage(snapshotId, projectId);
  const location = getDb()
    .select()
    .from(codeSnapshotLocations)
    .where(eq(codeSnapshotLocations.snapshotId, snapshotId))
    .get();
  if (!location) throw new SnapshotTransferError("snapshot_missing");
  return { pack, projectRoot: location.projectRoot };
}
export function getSnapshotExport(
  projectId: string,
  snapshotId: string,
): SnapshotTransferManifest | null {
  const row = getDb()
    .select()
    .from(snapshotExports)
    .where(
      and(eq(snapshotExports.snapshotId, snapshotId), eq(snapshotExports.projectId, projectId)),
    )
    .get();
  return row ? verifySnapshotTransferManifest(JSON.parse(row.manifestJson)) : null;
}
export function storeSnapshotExport(
  value: SnapshotTransferManifest,
  resources: Map<string, Buffer>,
): SnapshotTransferManifest {
  const manifest = verifySnapshotTransferManifest(value);
  const json = canonicalJson(manifest);
  return getDb().transaction((tx) => {
    const previous = getSnapshotExport(manifest.descriptor.projectId, manifest.snapshotId);
    if (previous) {
      if (canonicalJson(previous) !== json) throw new SnapshotTransferError("snapshot_conflict");
      return previous;
    }
    const size = snapshotResources(manifest).reduce((total, resource) => total + resource.size, 0);
    const used = tx
      .select({ bytes: sql<number>`coalesce(sum(${snapshotExports.byteSize}), 0)` })
      .from(snapshotExports)
      .get()!.bytes;
    if (used + size > STORAGE_LIMIT) throw new SnapshotTransferError("snapshot_quota");
    for (const resource of snapshotResources(manifest)) {
      const bytes = resources.get(resource.digest);
      if (!bytes || bytes.length !== resource.size || contextBlobDigest(bytes) !== resource.digest)
        throw new SnapshotTransferError("snapshot_incomplete");
      for (let ordinal = 0; ordinal < resource.chunks.length; ordinal++)
        writeChunk(
          owner(manifest.snapshotId, true),
          resource,
          ordinal,
          bytes
            .subarray(ordinal * SNAPSHOT_CHUNK_BYTES, (ordinal + 1) * SNAPSHOT_CHUNK_BYTES)
            .toString("base64"),
        );
    }
    tx.insert(snapshotExports)
      .values({
        snapshotId: manifest.snapshotId,
        projectId: manifest.descriptor.projectId,
        manifestJson: json,
        byteSize: size,
      })
      .run();
    return manifest;
  });
}
export function readPeerSnapshotManifest(
  peerId: string,
  projectId: string,
  snapshotId: string,
): SnapshotTransferManifest {
  requirePeerProject(peerId, projectId);
  const manifest = getSnapshotExport(projectId, snapshotId);
  if (!manifest) throw new SnapshotTransferError("snapshot_missing");
  return manifest;
}
export function readPeerSnapshotChunk(
  peerId: string,
  projectId: string,
  snapshotId: string,
  digest: string,
  ordinal: number,
) {
  const manifest = readPeerSnapshotManifest(peerId, projectId, snapshotId);
  const resource = snapshotResources(manifest).find((value) => value.digest === digest);
  if (!resource) throw new SnapshotTransferError("snapshot_invalid");
  const row = getDb()
    .select()
    .from(snapshotChunks)
    .where(
      and(
        eq(snapshotChunks.ownerId, owner(snapshotId, true)),
        eq(snapshotChunks.digest, digest),
        eq(snapshotChunks.ordinal, ordinal),
      ),
    )
    .get();
  if (!row) throw new SnapshotTransferError("snapshot_incomplete");
  checkChunk(resource, ordinal, row.base64);
  return { digest, ordinal, base64: row.base64 };
}

export interface SnapshotPullInput {
  peerId: string;
  projectId: string;
  snapshotId: string;
  checkoutId: string;
  worktreePath: string;
}
export function resolveSnapshotTarget(
  input: Pick<SnapshotPullInput, "peerId" | "projectId" | "checkoutId">,
) {
  requirePeerProject(input.peerId, input.projectId);
  const row = getDb()
    .select()
    .from(projectCheckouts)
    .where(
      and(
        eq(projectCheckouts.id, input.checkoutId),
        eq(projectCheckouts.projectId, input.projectId),
        eq(projectCheckouts.deviceId, getLocalDevice().deviceId),
      ),
    )
    .get();
  if (!row) throw new SnapshotTransferError("snapshot_binding_missing");
  const native = { win32: "native_windows", darwin: "native_macos", linux: "native_linux" }[
    process.platform as "win32" | "darwin" | "linux"
  ];
  if (!native || row.executionEnvironment !== native)
    throw new SnapshotTransferError("snapshot_binding_missing");
  return row;
}
export function beginSnapshotTransfer(input: SnapshotPullInput, value: unknown) {
  const manifest = verifySnapshotTransferManifest(value);
  const target = resolveSnapshotTarget(input);
  const db = getDb();
  const task = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, manifest.descriptor.taskId), eq(tasks.projectId, input.projectId)))
    .get();
  if (
    !task ||
    manifest.snapshotId !== input.snapshotId ||
    manifest.descriptor.projectId !== input.projectId ||
    !isAbsolute(input.worktreePath)
  )
    throw new SnapshotTransferError("snapshot_invalid");
  const worktreePath = resolve(input.worktreePath);
  return db.transaction((tx) => {
    const rows = tx.select().from(snapshotTransfers).all();
    const existing = rows.find(
      (row) =>
        row.peerId === input.peerId &&
        row.snapshotId === input.snapshotId &&
        row.checkoutId === input.checkoutId,
    );
    const manifestJson = canonicalJson(manifest);
    if (existing) {
      if (
        existing.manifestJson !== manifestJson ||
        existing.worktreePath !== worktreePath ||
        existing.projectRoot !== target.localRoot
      )
        throw new SnapshotTransferError("snapshot_conflict");
      return existing;
    }
    if (existsSync(worktreePath)) throw new SnapshotTransferError("snapshot_checkout_changed");
    const used = rows.reduce(
      (sum, row) =>
        sum +
        snapshotResources(verifySnapshotTransferManifest(JSON.parse(row.manifestJson))).reduce(
          (n, resource) => n + resource.size,
          0,
        ),
      0,
    );
    if (
      rows.length >= 100 ||
      used + snapshotResources(manifest).reduce((sum, resource) => sum + resource.size, 0) >
        STORAGE_LIMIT
    )
      throw new SnapshotTransferError("snapshot_quota");
    const row = {
      ...input,
      id: crypto.randomUUID(),
      worktreePath,
      projectRoot: target.localRoot,
      manifestJson,
      status: "downloading" as const,
      errorCode: null,
      codeReady: false,
      contextReady: false,
      selectedBundleDigest: null,
      completed: false,
    };
    tx.insert(snapshotTransfers).values(row).run();
    return row;
  });
}
export function getSnapshotTransfer(id: string) {
  const row = getDb().select().from(snapshotTransfers).where(eq(snapshotTransfers.id, id)).get();
  if (!row) throw new SnapshotTransferError("snapshot_missing");
  const target = resolveSnapshotTarget(row);
  if (target.localRoot !== row.projectRoot)
    throw new SnapshotTransferError("snapshot_binding_missing");
  const manifest = verifySnapshotTransferManifest(JSON.parse(row.manifestJson));
  const task = getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, manifest.descriptor.taskId), eq(tasks.projectId, row.projectId)))
    .get();
  if (!task) throw new SnapshotTransferError("snapshot_missing");
  return { ...row, manifest };
}
export function stageSnapshotChunk(
  id: string,
  digest: string,
  ordinal: number,
  base64: string,
): void {
  getDb().transaction(() => {
    const row = getSnapshotTransfer(id);
    const resource = snapshotResources(row.manifest).find((item) => item.digest === digest);
    if (!resource) throw new SnapshotTransferError("snapshot_invalid");
    writeChunk(owner(id), resource, ordinal, base64);
  });
}
export function missingSnapshotChunks(id: string, resource: SnapshotResource): number[] {
  const row = getSnapshotTransfer(id);
  if (
    !snapshotResources(row.manifest).some(
      (value) => canonicalJson(value) === canonicalJson(resource),
    )
  )
    throw new SnapshotTransferError("snapshot_invalid");
  const stored = new Set(
    getDb()
      .select({ ordinal: snapshotChunks.ordinal })
      .from(snapshotChunks)
      .where(and(eq(snapshotChunks.ownerId, owner(id)), eq(snapshotChunks.digest, resource.digest)))
      .all()
      .map((chunk) => chunk.ordinal),
  );
  return resource.chunks.map((_, index) => index).filter((index) => !stored.has(index));
}
export function readSnapshotResource(id: string, resource: SnapshotResource): Buffer {
  if (missingSnapshotChunks(id, resource).length > 0)
    throw new SnapshotTransferError("snapshot_incomplete");
  const rows = getDb()
    .select()
    .from(snapshotChunks)
    .where(and(eq(snapshotChunks.ownerId, owner(id)), eq(snapshotChunks.digest, resource.digest)))
    .all();
  rows.sort((a, b) => a.ordinal - b.ordinal);
  const bytes = Buffer.concat(rows.map((row) => checkChunk(resource, row.ordinal, row.base64)));
  if (bytes.length !== resource.size || contextBlobDigest(bytes) !== resource.digest)
    throw new SnapshotTransferError("snapshot_invalid");
  return bytes;
}
export function updateSnapshotTransfer(
  id: string,
  patch: Partial<
    Pick<
      typeof snapshotTransfers.$inferSelect,
      "status" | "errorCode" | "codeReady" | "contextReady" | "selectedBundleDigest" | "completed"
    >
  >,
) {
  getSnapshotTransfer(id);
  getDb().update(snapshotTransfers).set(patch).where(eq(snapshotTransfers.id, id)).run();
}
export function snapshotTransferProgress(id: string) {
  const row = getSnapshotTransfer(id);
  const resources = snapshotResources(row.manifest).filter(
    (resource) =>
      row.manifest.contextBlobs.includes(resource) || resource.digest === row.selectedBundleDigest,
  );
  const totalChunks = resources.reduce((sum, resource) => sum + resource.chunks.length, 0);
  const missingChunks = resources.reduce(
    (sum, resource) => sum + missingSnapshotChunks(id, resource).length,
    0,
  );
  return {
    id,
    snapshotId: row.snapshotId,
    projectId: row.projectId,
    peerId: row.peerId,
    status: row.status,
    errorCode: row.errorCode,
    codeReady: row.codeReady,
    contextReady: row.contextReady,
    checkoutReady: row.status === "ready",
    executionReady: false,
    receivedChunks: totalChunks - missingChunks,
    totalChunks,
  };
}
export function listSnapshotTransfers(projectId: string) {
  return getDb()
    .select({
      id: snapshotTransfers.id,
      peerId: snapshotTransfers.peerId,
      projectId: snapshotTransfers.projectId,
      snapshotId: snapshotTransfers.snapshotId,
    })
    .from(snapshotTransfers)
    .where(eq(snapshotTransfers.projectId, projectId))
    .all();
}
/** Local admin cleanup removes transfer records/chunks only, never Git or user files. */
export function deleteSnapshotTransfer(id: string): void {
  getDb().transaction((tx) => {
    tx.delete(snapshotChunks)
      .where(eq(snapshotChunks.ownerId, owner(id)))
      .run();
    tx.delete(snapshotTransfers).where(eq(snapshotTransfers.id, id)).run();
  });
}
export function deleteSnapshotExport(projectId: string, snapshotId: string): void {
  getDb().transaction((tx) => {
    if (!getSnapshotExport(projectId, snapshotId)) return;
    tx.delete(snapshotChunks)
      .where(eq(snapshotChunks.ownerId, owner(snapshotId, true)))
      .run();
    tx.delete(snapshotExports).where(eq(snapshotExports.snapshotId, snapshotId)).run();
  });
}
