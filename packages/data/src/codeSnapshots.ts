import { and, eq } from "drizzle-orm";
import {
  canonicalJson,
  captureCodeSnapshotPackage,
  CodeSnapshotError,
  codeSnapshots,
  contextSnapshotBlobs,
  codeSnapshotLocations,
  pinCodeSnapshot,
  verifyCodeSnapshotPackage,
  tasks,
  PersonalExecutionDisabledError,
  contextManifestSchema,
  type CodeSnapshotPackage,
  type ContinuationNotes,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import { getPersonalExecutionBlock } from "./personalMode.js";
import { getTaskExecutionWorkspace, publishTaskWorkspaceCheckpoint } from "./taskWorkspaces.js";

/** Atomic, immutable metadata/blob ingestion. A metadata-only package cannot be
 * made ready by guessing digests of other projects' already-stored blobs. */
export function storeCodeSnapshotPackage(value: unknown): CodeSnapshotPackage {
  const pack = verifyCodeSnapshotPackage(value);
  const descriptorJson = canonicalJson(pack.descriptor);
  const contextJson = canonicalJson(pack.context);
  getDb().transaction((tx) => {
    const existing = tx.select().from(codeSnapshots).where(eq(codeSnapshots.id, pack.id)).get();
    if (
      existing &&
      (existing.descriptorJson !== descriptorJson || existing.contextJson !== contextJson)
    )
      throw new CodeSnapshotError(
        "snapshot_conflict",
        "Immutable snapshot metadata differs from local storage",
      );
    for (const blob of pack.blobs) {
      const stored = tx
        .select()
        .from(contextSnapshotBlobs)
        .where(eq(contextSnapshotBlobs.digest, blob.digest))
        .get();
      if (stored && stored.base64 !== blob.base64)
        throw new CodeSnapshotError(
          "snapshot_conflict",
          "Immutable context blob differs from local storage",
        );
      if (!stored) tx.insert(contextSnapshotBlobs).values(blob).run();
    }
    if (!existing)
      tx.insert(codeSnapshots)
        .values({
          id: pack.id,
          projectId: pack.descriptor.projectId,
          taskId: pack.descriptor.taskId,
          descriptorJson,
          contextJson,
        })
        .run();
  });
  return pack;
}

export function loadCodeSnapshotPackage(id: string, projectId: string): CodeSnapshotPackage {
  const db = getDb();
  const row = db
    .select()
    .from(codeSnapshots)
    .where(and(eq(codeSnapshots.id, id), eq(codeSnapshots.projectId, projectId)))
    .get();
  if (!row)
    throw new CodeSnapshotError("invalid_package", "Snapshot is not available for this project");
  let descriptor: unknown;
  let context: unknown;
  try {
    descriptor = JSON.parse(row.descriptorJson);
    context = JSON.parse(row.contextJson);
  } catch {
    throw new CodeSnapshotError("invalid_package", "Invalid local snapshot metadata");
  }
  // Parse the descriptor/manifest before using their digest references.
  const parsed = contextManifestSchema.safeParse(context);
  if (!parsed.success)
    throw new CodeSnapshotError("invalid_package", "Invalid local context manifest");
  const blobs = [...new Set(parsed.data.files.map((file) => file.digest))].map((digest) => {
    const blob = db
      .select()
      .from(contextSnapshotBlobs)
      .where(eq(contextSnapshotBlobs.digest, digest))
      .get();
    if (!blob) throw new CodeSnapshotError("missing_blob", "A stored context blob is missing");
    return blob;
  });
  return verifyCodeSnapshotPackage({ id: row.id, descriptor, context, blobs });
}

export function captureTaskCodeSnapshot(input: {
  taskId: string;
  notes: ContinuationNotes;
  portablePaths?: string[];
}): CodeSnapshotPackage {
  const row = getTaskExecutionWorkspace(input.taskId);
  if (!row) throw new CodeSnapshotError("missing_code", "The task has no execution workspace");
  if (getPersonalExecutionBlock(row.projectId, row.taskId))
    throw new PersonalExecutionDisabledError();
  if (row.state !== "checkpointed")
    throw new CodeSnapshotError("missing_code", "Seal the workspace before capturing context");
  const checkpoint = publishTaskWorkspaceCheckpoint(row.taskId);
  const task = getDb().select().from(tasks).where(eq(tasks.id, row.taskId)).get();
  if (!task) throw new CodeSnapshotError("missing_code", "The task no longer exists");
  const inherited = row.sourceSnapshotId
    ? loadCodeSnapshotPackage(row.sourceSnapshotId, row.projectId)
        .context.files.filter((file) => file.source === "portable")
        .map((file) => file.path)
    : [];
  const pack = captureCodeSnapshotPackage({
    checkout: {
      projectRoot: row.projectRoot,
      worktreePath: row.worktreePath,
      projectId: row.projectId,
      taskId: row.taskId,
      snapshotCommit: row.snapshotCommit,
    },
    commitSha: checkpoint.commitSha ?? row.snapshotCommit,
    sourceDeviceId: getLocalDevice().deviceId,
    parentSnapshotId: row.sourceSnapshotId,
    notes: input.notes,
    planText: task.plan,
    portablePaths: input.portablePaths ?? inherited,
  });
  // Revalidate code and DB identity after reading context, before making it available.
  publishTaskWorkspaceCheckpoint(row.taskId);
  const current = getTaskExecutionWorkspace(row.taskId);
  const currentTask = getDb().select().from(tasks).where(eq(tasks.id, row.taskId)).get();
  if (!current || current.revision !== row.revision || currentTask?.plan !== task.plan)
    throw new CodeSnapshotError("snapshot_conflict", "Task context changed during capture");
  storeCodeSnapshotPackage(pack);
  pinCodeSnapshot(row.projectRoot, pack);
  getDb()
    .insert(codeSnapshotLocations)
    .values({ snapshotId: pack.id, projectRoot: row.projectRoot })
    .onConflictDoNothing()
    .run();
  return pack;
}

export function verifyLocalCodeSnapshot(
  id: string,
  projectId: string,
  projectRoot: string,
): CodeSnapshotPackage {
  const pack = loadCodeSnapshotPackage(id, projectId);
  // Re-pinning is idempotent and verifies the exact Git object, not a mutable branch name.
  pinCodeSnapshot(projectRoot, pack);
  return pack;
}

/** Host-only registration after verified import; never accepts a peer-provided path. */
export function recordLocalCodeSnapshot(
  projectId: string,
  snapshotId: string,
  projectRoot: string,
): void {
  verifyLocalCodeSnapshot(snapshotId, projectId, projectRoot);
  getDb()
    .insert(codeSnapshotLocations)
    .values({ snapshotId, projectRoot })
    .onConflictDoNothing()
    .run();
}
