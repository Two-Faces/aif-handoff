import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  logicalParticipants,
  logicalTaskAssignments,
  participantBindings,
  participants,
  projects,
  taskAssignments,
  taskComments,
  taskExecutorHistory,
  tasks,
  sharedCommentFields,
  sharedHistoryFields,
  sharedParticipantFields,
  sharedProjectFields,
  sharedTaskFields,
  SyncError,
  type AuditActor,
  type SyncEntityType,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import { resolveLocalParticipant } from "./participantBindings.js";
import {
  readSyncEntity,
  readSyncVersions,
  runRemoteSyncProjection,
  type SyncEntityRef,
} from "./syncJournal.js";

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new SyncError("invalid_operation");
  }
}

function portableAttachments(raw: string) {
  const values = json(raw);
  if (!Array.isArray(values)) throw new SyncError("invalid_operation");
  return values.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new SyncError("invalid_operation");
    return {
      name: "name" in value ? value.name : undefined,
      mimeType: "mimeType" in value ? value.mimeType : undefined,
      size: "size" in value ? value.size : undefined,
      content: null,
    };
  });
}

/** Legacy local attribution may be inactive; this never grants an active account. */
function historicalIdentity(projectId: string, participantId: string, displayName: string) {
  const db = getDb();
  const binding = db
    .select()
    .from(participantBindings)
    .where(
      and(
        eq(participantBindings.projectId, projectId),
        eq(participantBindings.participantId, participantId),
      ),
    )
    .get();
  if (binding) return binding.logicalParticipantId;
  const person = db.select().from(participants).where(eq(participants.id, participantId)).get();
  const hash = createHash("sha256")
    .update(`${getLocalDevice().deviceId}:${projectId}:${participantId}`)
    .digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  db.insert(logicalParticipants)
    .values({ projectId, id, displayName: person?.displayName ?? displayName })
    .onConflictDoNothing()
    .run();
  if (person)
    db.insert(participantBindings)
      .values({ projectId, logicalParticipantId: id, participantId })
      .onConflictDoNothing()
      .run();
  return id;
}

export function portableActor(projectId: string, actor?: AuditActor) {
  if (!actor) return null;
  return {
    id:
      actor.kind === "participant" && actor.id
        ? historicalIdentity(projectId, actor.id, actor.displayNameSnapshot ?? "")
        : null,
    displayName: actor.displayNameSnapshot ?? "",
  };
}

function portableAssignees(projectId: string, raw: string) {
  const values = json(raw);
  if (!Array.isArray(values)) throw new SyncError("invalid_operation");
  return values.map((value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("displayName" in value) ||
      typeof value.displayName !== "string"
    )
      throw new SyncError("invalid_operation");
    const localId =
      "participantId" in value && typeof value.participantId === "string"
        ? value.participantId
        : null;
    return {
      id: localId ? historicalIdentity(projectId, localId, value.displayName) : null,
      displayName: value.displayName,
    };
  });
}

export function prepareLocalTaskIdentity(taskId: string): void {
  const db = getDb();
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;
  const assigned = db
    .select({ id: participants.id, name: participants.displayName })
    .from(taskAssignments)
    .innerJoin(participants, eq(taskAssignments.participantId, participants.id))
    .where(eq(taskAssignments.taskId, taskId))
    .all();
  db.delete(logicalTaskAssignments).where(eq(logicalTaskAssignments.taskId, taskId)).run();
  for (const person of assigned) {
    db.insert(logicalTaskAssignments)
      .values({
        taskId,
        logicalParticipantId: historicalIdentity(task.projectId, person.id, person.name),
        displayNameSnapshot: person.name,
      })
      .run();
  }
}

export function prepareLocalCommentIdentity(commentId: string): void {
  const db = getDb();
  const comment = db.select().from(taskComments).where(eq(taskComments.id, commentId)).get();
  if (!comment?.participantId || comment.logicalAuthorId) return;
  const task = db.select().from(tasks).where(eq(tasks.id, comment.taskId)).get();
  const person = db
    .select()
    .from(participants)
    .where(eq(participants.id, comment.participantId))
    .get();
  if (!task || !person) return;
  db.update(taskComments)
    .set({
      logicalAuthorId: historicalIdentity(task.projectId, person.id, person.displayName),
      authorDisplayNameSnapshot: person.displayName,
    })
    .where(eq(taskComments.id, commentId))
    .run();
}

/** Whitelist only: none of the local root/runtime/auth fields can reach the wire. */
export function captureSharedEntity(ref: SyncEntityRef): Record<string, unknown> | null {
  const db = getDb();
  if (ref.entityType === "project") {
    const row = db.select().from(projects).where(eq(projects.id, ref.entityId)).get();
    return row
      ? sharedProjectFields.parse({
          name: row.name,
          groupName: row.groupName,
          pinnedAt: row.pinnedAt,
          createdAt: row.createdAt,
        })
      : null;
  }
  if (ref.entityType === "participant") {
    const row = db
      .select()
      .from(logicalParticipants)
      .where(
        and(
          eq(logicalParticipants.projectId, ref.projectId),
          eq(logicalParticipants.id, ref.entityId),
        ),
      )
      .get();
    return row ? sharedParticipantFields.parse({ displayName: row.displayName }) : null;
  }
  if (ref.entityType === "task") {
    const row = db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, ref.entityId), eq(tasks.projectId, ref.projectId)))
      .get();
    if (!row) return null;
    const assignees = db
      .select()
      .from(logicalTaskAssignments)
      .where(eq(logicalTaskAssignments.taskId, row.id))
      .all()
      .map((person) => ({
        id: person.logicalParticipantId,
        displayName: person.displayNameSnapshot,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return sharedTaskFields.parse({
      title: row.title,
      description: row.description,
      plan: row.plan,
      priority: row.priority,
      position: row.position,
      workflow: {
        status: row.status,
        executionOwner: row.executionOwner,
        ownershipRevision: row.ownershipRevision,
        assignees,
        blockedFromStatus: row.blockedFromStatus,
        manualReviewRequired: row.manualReviewRequired,
        reworkRequested: row.reworkRequested,
      },
      attachments: portableAttachments(row.attachments),
      tags: json(row.tags),
      isFix: row.isFix,
      plannerMode: row.plannerMode,
      planDocs: row.planDocs,
      planTests: row.planTests,
      skipReview: row.skipReview,
      useSubagents: row.useSubagents,
      runPlanImprove: row.runPlanImprove,
      runPostVerify: row.runPostVerify,
      implementationLog: row.implementationLog,
      reviewComments: row.reviewComments,
      roadmapAlias: row.roadmapAlias,
      scheduledAt: row.scheduledAt,
      createdAt: row.createdAt,
    });
  }
  if (ref.entityType === "comment") {
    const row = db.select().from(taskComments).where(eq(taskComments.id, ref.entityId)).get();
    if (!row) return null;
    return sharedCommentFields.parse({
      taskId: row.taskId,
      author: row.author,
      logicalAuthorId: row.logicalAuthorId,
      authorDisplayNameSnapshot: row.authorDisplayNameSnapshot,
      message: row.message,
      attachments: portableAttachments(row.attachments),
      createdAt: row.createdAt,
    });
  }
  const row = db
    .select()
    .from(taskExecutorHistory)
    .where(eq(taskExecutorHistory.id, ref.entityId))
    .get();
  if (!row) return null;
  return sharedHistoryFields.parse({
    taskId: row.taskId,
    taskTitleSnapshot: row.taskTitleSnapshot,
    ownershipRevision: row.ownershipRevision,
    executionOwner: row.executionOwner,
    assignees: portableAssignees(ref.projectId, row.assigneesSnapshotJson),
    statusSnapshot: row.statusSnapshot,
    actorKind: row.actorKind,
    actor: portableActor(ref.projectId, {
      kind: row.actorKind,
      id: row.actorId,
      displayNameSnapshot: row.actorDisplayNameSnapshot,
    }),
    reason: row.reason,
    createdAt: row.createdAt,
  });
}

export function projectIdForEntity(type: SyncEntityType, id: string): string | null {
  const db = getDb();
  if (type === "project") return id;
  if (type === "task")
    return (
      db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, id)).get()
        ?.projectId ?? null
    );
  if (type === "comment") {
    const row = db
      .select({ taskId: taskComments.taskId })
      .from(taskComments)
      .where(eq(taskComments.id, id))
      .get();
    return row ? projectIdForEntity("task", row.taskId) : null;
  }
  if (type === "history") {
    const row = db
      .select({ taskId: taskExecutorHistory.taskId })
      .from(taskExecutorHistory)
      .where(eq(taskExecutorHistory.id, id))
      .get();
    return row ? projectIdForEntity("task", row.taskId) : null;
  }
  return null;
}

function checkParent(projectId: string, taskId: string): boolean {
  if (readSyncVersions(projectId, "task", taskId).__deleted) return false;
  const parent = projectIdForEntity("task", taskId);
  if (!parent) throw new SyncError("entity_not_ready");
  if (parent !== projectId) throw new SyncError("stream_scope_mismatch");
  return true;
}

/** Remote materialization is SQL only: no domain actions, Git, runtime, files or outgoing writes. */
export function materializeSharedEntity(
  ref: SyncEntityRef,
  fields: Record<string, unknown> | null,
): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, ref.projectId)).get();
  if (project && !project.personalMode) throw new SyncError("stream_scope_mismatch");
  if (
    ref.entityType !== "project" &&
    readSyncVersions(ref.projectId, "project", ref.projectId).__deleted
  )
    return;
  if (ref.entityType !== "project" && !project) throw new SyncError("entity_not_ready");
  const existingScope =
    ref.entityType === "participant" ? null : projectIdForEntity(ref.entityType, ref.entityId);
  if (existingScope && existingScope !== ref.projectId)
    throw new SyncError("stream_scope_mismatch");
  if (!fields) {
    if (ref.entityType === "project") {
      db.delete(taskComments)
        .where(
          inArray(
            taskComments.taskId,
            db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, ref.projectId)),
          ),
        )
        .run();
      db.delete(tasks).where(eq(tasks.projectId, ref.projectId)).run();
      db.delete(projects).where(eq(projects.id, ref.projectId)).run();
    } else if (ref.entityType === "task") {
      db.delete(taskComments).where(eq(taskComments.taskId, ref.entityId)).run();
      db.delete(tasks).where(eq(tasks.id, ref.entityId)).run();
    } else if (ref.entityType === "comment")
      db.delete(taskComments).where(eq(taskComments.id, ref.entityId)).run();
    return;
  }
  if (ref.entityType === "project") {
    const value = sharedProjectFields.parse(fields);
    db.insert(projects)
      .values({
        id: ref.projectId,
        rootPath: "",
        personalMode: true,
        publicationPolicy: "local_only",
        ...value,
      })
      .onConflictDoUpdate({ target: projects.id, set: value })
      .run();
    return;
  }
  if (ref.entityType === "participant") {
    const value = sharedParticipantFields.parse(fields);
    db.insert(logicalParticipants)
      .values({ projectId: ref.projectId, id: ref.entityId, ...value })
      .onConflictDoUpdate({
        target: [logicalParticipants.projectId, logicalParticipants.id],
        set: value,
      })
      .run();
    return;
  }
  if (ref.entityType === "task") {
    const { workflow, attachments, tags, ...value } = sharedTaskFields.parse(fields);
    const previousTask = db.select().from(tasks).where(eq(tasks.id, ref.entityId)).get();
    const localAttachments =
      previousTask &&
      JSON.stringify(portableAttachments(previousTask.attachments)) === JSON.stringify(attachments)
        ? previousTask.attachments
        : JSON.stringify(attachments);
    const { assignees, ...workflowFields } = workflow;
    const patch = {
      ...value,
      ...workflowFields,
      attachments: localAttachments,
      tags: JSON.stringify(tags),
    };
    db.insert(tasks)
      .values({
        id: ref.entityId,
        projectId: ref.projectId,
        paused: true,
        autoMode: false,
        ...patch,
      })
      .onConflictDoUpdate({ target: tasks.id, set: patch })
      .run();
    db.delete(logicalTaskAssignments).where(eq(logicalTaskAssignments.taskId, ref.entityId)).run();
    const previous = db
      .select()
      .from(taskAssignments)
      .where(eq(taskAssignments.taskId, ref.entityId))
      .all();
    const localIds = new Set<string>();
    for (const assignee of assignees) {
      db.insert(logicalTaskAssignments)
        .values({
          taskId: ref.entityId,
          logicalParticipantId: assignee.id,
          displayNameSnapshot: assignee.displayName,
        })
        .run();
      const localId = resolveLocalParticipant(ref.projectId, assignee.id);
      if (localId && !localIds.has(localId)) {
        localIds.add(localId);
        if (!previous.some((entry) => entry.participantId === localId))
          db.insert(taskAssignments)
            .values({
              taskId: ref.entityId,
              participantId: localId,
              assignedByKind: "system",
              assignedByDisplayNameSnapshot: "Peer synchronization",
            })
            .run();
      }
    }
    for (const entry of previous) {
      if (!localIds.has(entry.participantId))
        db.delete(taskAssignments)
          .where(
            and(
              eq(taskAssignments.taskId, ref.entityId),
              eq(taskAssignments.participantId, entry.participantId),
            ),
          )
          .run();
    }
    return;
  }
  if (ref.entityType === "comment") {
    const value = sharedCommentFields.parse(fields);
    if (!checkParent(ref.projectId, value.taskId)) return;
    const previous = db.select().from(taskComments).where(eq(taskComments.id, ref.entityId)).get();
    if (previous && previous.taskId !== value.taskId) throw new SyncError("stream_scope_mismatch");
    const patch = {
      ...value,
      participantId: value.logicalAuthorId
        ? resolveLocalParticipant(ref.projectId, value.logicalAuthorId)
        : null,
      attachments:
        previous &&
        JSON.stringify(portableAttachments(previous.attachments)) ===
          JSON.stringify(value.attachments)
          ? previous.attachments
          : JSON.stringify(value.attachments),
    };
    db.insert(taskComments)
      .values({ id: ref.entityId, ...patch })
      .onConflictDoUpdate({ target: taskComments.id, set: patch })
      .run();
    return;
  }
  const { actor, assignees, ...value } = sharedHistoryFields.parse(fields);
  if (!checkParent(ref.projectId, value.taskId)) return;
  const previous = db
    .select()
    .from(taskExecutorHistory)
    .where(eq(taskExecutorHistory.id, ref.entityId))
    .get();
  if (previous && previous.taskId !== value.taskId) throw new SyncError("stream_scope_mismatch");
  const snapshots = assignees.flatMap((person) => {
    const localId = person.id ? resolveLocalParticipant(ref.projectId, person.id) : null;
    const local = localId
      ? db.select().from(participants).where(eq(participants.id, localId)).get()
      : null;
    return local
      ? [
          {
            participantId: local.id,
            displayName: person.displayName,
            role: local.role,
            active: local.active,
          },
        ]
      : [];
  });
  db.insert(taskExecutorHistory)
    .values({
      id: ref.entityId,
      ...value,
      actorId: actor?.id ? resolveLocalParticipant(ref.projectId, actor.id) : null,
      actorDisplayNameSnapshot: actor?.displayName ?? null,
      assigneesSnapshotJson: JSON.stringify(snapshots),
    })
    .onConflictDoNothing()
    .run();
}

/** An explicit local identity binding reprojects permissions without publishing a board edit. */
export function refreshLocalParticipantProjection(projectId: string): void {
  runRemoteSyncProjection(() => {
    const db = getDb();
    const taskRows = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .all();
    for (const row of taskRows) {
      const fields = readSyncEntity(projectId, "task", row.id);
      if (fields)
        materializeSharedEntity({ projectId, entityType: "task", entityId: row.id }, fields);
    }
    const comments = db
      .select({ id: taskComments.id })
      .from(taskComments)
      .where(
        inArray(
          taskComments.taskId,
          taskRows.map((row) => row.id),
        ),
      )
      .all();
    for (const row of comments) {
      const fields = readSyncEntity(projectId, "comment", row.id);
      if (fields)
        materializeSharedEntity({ projectId, entityType: "comment", entityId: row.id }, fields);
    }
  });
}
