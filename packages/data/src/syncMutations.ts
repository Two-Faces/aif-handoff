import { and, eq, inArray, notExists } from "drizzle-orm";
import {
  canonicalJson,
  dotKey,
  logicalParticipants,
  projects,
  syncFields,
  taskComments,
  taskExecutorHistory,
  tasks,
  SyncError,
  type AuditActor,
  type SyncEntityType,
  type SyncRevisions,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { withTaskDeviceMutation, withCurrentTaskDeviceMutation } from "./deviceExecution.js";
import {
  captureSharedEntity,
  portableActor,
  prepareLocalCommentIdentity,
  prepareLocalTaskIdentity,
  projectIdForEntity,
} from "./syncDomain.js";
import {
  isApplyingRemoteSync,
  readSyncVersions,
  recordLocalSyncChange,
  type SyncEntityRef,
} from "./syncJournal.js";

export interface SharedMutationOptions {
  expected?: SyncRevisions;
  actor?: AuditActor;
  requireExpected?: boolean;
}
interface MutationRef {
  entityType: SyncEntityType;
  entityId?: string;
  projectId?: string;
  createPersonalProject?: boolean;
  deleting?: boolean;
  execution?: boolean;
}
const seeding = new Set<string>();
const active = new Set<string>();

export function isReplicatedProject(projectId: string): boolean {
  return (
    getDb()
      .select({ personal: projects.personalMode })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()?.personal === true
  );
}

export function getEntitySyncRevisions(
  projectId: string,
  entityType: SyncEntityType,
  entityId: string,
): SyncRevisions {
  return Object.fromEntries(
    Object.entries(readSyncVersions(projectId, entityType, entityId))
      .filter(([field]) => !field.startsWith("__"))
      .map(([field, versions]) => [field, versions.map((version) => version.dot)]),
  );
}

export function recordIdentityDependencies(projectId: string): void {
  const identities = getDb()
    .select()
    .from(logicalParticipants)
    .where(
      and(
        eq(logicalParticipants.projectId, projectId),
        notExists(
          getDb()
            .select({ id: syncFields.entityId })
            .from(syncFields)
            .where(
              and(
                eq(syncFields.projectId, projectId),
                eq(syncFields.entityType, "participant"),
                eq(syncFields.entityId, logicalParticipants.id),
                eq(syncFields.field, "__created"),
              ),
            ),
        ),
      ),
    )
    .all();
  for (const identity of identities) {
    recordLocalSyncChange({
      projectId,
      entityType: "participant",
      entityId: identity.id,
      intent: "create",
      fields: { displayName: identity.displayName },
    });
  }
}

function recordHistory(projectId: string, taskId: string): void {
  const history = getDb()
    .select({ id: taskExecutorHistory.id })
    .from(taskExecutorHistory)
    .where(
      and(
        eq(taskExecutorHistory.taskId, taskId),
        notExists(
          getDb()
            .select({ id: syncFields.entityId })
            .from(syncFields)
            .where(
              and(
                eq(syncFields.projectId, projectId),
                eq(syncFields.entityType, "history"),
                eq(syncFields.entityId, taskExecutorHistory.id),
                eq(syncFields.field, "__created"),
              ),
            ),
        ),
      ),
    )
    .all();
  for (const entry of history) {
    const ref = { projectId, entityType: "history" as const, entityId: entry.id };
    const fields = captureSharedEntity(ref);
    recordIdentityDependencies(projectId);
    if (fields) recordLocalSyncChange({ ...ref, intent: "create", fields });
  }
}

/** Capture a legacy personal board once; subsequent writes journal only their delta. */
export function ensureProjectSyncState(projectId: string): void {
  if (isApplyingRemoteSync() || seeding.has(projectId) || !isReplicatedProject(projectId)) return;
  const versions = readSyncVersions(projectId, "project", projectId);
  if (versions.__deleted) throw new SyncError("invalid_transition");
  if (versions.__created) return;
  getDb().transaction((tx) => {
    seeding.add(projectId);
    try {
      const root = { projectId, entityType: "project" as const, entityId: projectId };
      const fields = captureSharedEntity(root);
      if (!fields) throw new SyncError("entity_not_ready");
      recordLocalSyncChange({ ...root, intent: "create", fields });
      const taskRows = tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .all();
      const comments = tx
        .select({ id: taskComments.id })
        .from(taskComments)
        .where(
          inArray(
            taskComments.taskId,
            tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId)),
          ),
        )
        .all();
      for (const task of taskRows) prepareLocalTaskIdentity(task.id);
      for (const comment of comments) prepareLocalCommentIdentity(comment.id);
      recordIdentityDependencies(projectId);
      for (const task of taskRows) {
        const ref = { projectId, entityType: "task" as const, entityId: task.id };
        recordLocalSyncChange({ ...ref, intent: "create", fields: captureSharedEntity(ref)! });
        recordHistory(projectId, task.id);
      }
      for (const comment of comments) {
        const ref = { projectId, entityType: "comment" as const, entityId: comment.id };
        recordLocalSyncChange({ ...ref, intent: "create", fields: captureSharedEntity(ref)! });
      }
    } finally {
      seeding.delete(projectId);
    }
  });
}

function resultId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if ("id" in value && typeof value.id === "string") return value.id;
  return "taskId" in value && typeof value.taskId === "string" ? value.taskId : null;
}
function failed(value: unknown): boolean {
  return value !== null && typeof value === "object" && "ok" in value && value.ok === false;
}

function checkRevisions(
  ref: SyncEntityRef,
  fields: Record<string, unknown>,
  options: SharedMutationOptions,
): void {
  const current = getEntitySyncRevisions(ref.projectId, ref.entityType, ref.entityId);
  for (const field of Object.keys(fields)) {
    if (field === "position") continue;
    const required = options.requireExpected || field === "plan" || field === "workflow";
    const expected = options.expected?.[field];
    if (!expected) {
      if (required) throw new SyncError("sync_revision_required");
      continue;
    }
    if (
      canonicalJson(expected.map(dotKey).sort()) !==
      canonicalJson((current[field] ?? []).map(dotKey).sort())
    ) {
      throw new SyncError("sync_revision_conflict");
    }
  }
}

/** Every domain write and its journal records share this transaction. */
export function withSharedMutation<T>(
  input: MutationRef,
  mutate: () => T,
  options: SharedMutationOptions = {},
): T {
  return input.entityType === "task" && input.entityId
    ? withTaskDeviceMutation(
        input.entityId,
        () => sharedMutation(input, mutate, options),
        input.execution,
      )
    : withCurrentTaskDeviceMutation(() => sharedMutation(input, mutate, options));
}

function sharedMutation<T>(input: MutationRef, mutate: () => T, options: SharedMutationOptions): T {
  const knownProjectId =
    input.projectId ??
    (input.entityId ? projectIdForEntity(input.entityType, input.entityId) : null);
  if (
    isApplyingRemoteSync() ||
    (knownProjectId && seeding.has(knownProjectId)) ||
    (!input.createPersonalProject && (!knownProjectId || !isReplicatedProject(knownProjectId)))
  )
    return mutate();
  const key = input.entityId ? `${input.entityType}:${input.entityId}` : null;
  if (key && active.has(key)) return mutate();
  return getDb().transaction(() => {
    if (key) active.add(key);
    try {
      const beforeRef =
        knownProjectId && input.entityId
          ? { projectId: knownProjectId, entityType: input.entityType, entityId: input.entityId }
          : null;
      if (beforeRef) ensureProjectSyncState(beforeRef.projectId);
      const before = beforeRef ? captureSharedEntity(beforeRef) : null;
      const result = mutate();
      if (failed(result)) return result;
      const id = input.entityId ?? resultId(result);
      const projectId = knownProjectId ?? (input.entityType === "project" ? id : null);
      if (!id || !projectId) return result;
      const ref = { projectId, entityType: input.entityType, entityId: id };
      if (input.entityType === "task") {
        const current = captureSharedEntity(ref);
        const previousWorkflow = before?.workflow;
        const nextWorkflow = current?.workflow;
        const identityChanged =
          !before ||
          (previousWorkflow &&
            nextWorkflow &&
            typeof previousWorkflow === "object" &&
            typeof nextWorkflow === "object" &&
            "ownershipRevision" in previousWorkflow &&
            "ownershipRevision" in nextWorkflow &&
            previousWorkflow.ownershipRevision !== nextWorkflow.ownershipRevision);
        if (identityChanged && current) prepareLocalTaskIdentity(id);
      }
      if (input.entityType === "comment") prepareLocalCommentIdentity(id);
      const after = captureSharedEntity(ref);
      if (canonicalJson(before) === canonicalJson(after)) return result;
      const seeded = Boolean(readSyncVersions(projectId, "project", projectId).__created);
      if (!seeded && after) {
        ensureProjectSyncState(projectId);
        return result;
      }
      const actor = portableActor(projectId, options.actor);
      recordIdentityDependencies(projectId);
      const changed = after
        ? Object.fromEntries(
            Object.entries(after).filter(
              ([field, value]) => !before || canonicalJson(before[field]) !== canonicalJson(value),
            ),
          )
        : {};
      if (before && after) checkRevisions(ref, changed, options);
      recordLocalSyncChange({
        ...ref,
        intent: after ? (before ? "update" : "create") : "delete",
        fields: changed,
        actorKind: options.actor?.kind ?? "system",
        actor,
      });
      if (input.entityType === "task" && after) recordHistory(projectId, id);
      return result;
    } finally {
      if (key) active.delete(key);
    }
  });
}
