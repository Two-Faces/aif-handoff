import { relative, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  assertTaskCheckout,
  beginTaskChangeScope,
  prepareTaskCheckout,
  prepareTaskCommit,
  publishTaskCommit,
  restoreTaskChangeScope,
  restoreTaskCommitIntent,
  serializeTaskChangeScope,
  serializeTaskCommitIntent,
  taskExecutionWorkspaces,
  taskWorkspaceContinuations,
  taskCheckoutFilePath,
  installContextSnapshot,
  tasks,
  projects,
  PersonalExecutionDisabledError,
  type TaskCheckoutInput,
  type TaskCommitResult,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getPersonalExecutionBlock } from "./personalMode.js";
import { verifyLocalCodeSnapshot } from "./codeSnapshots.js";
import { assertTaskDeviceExecution } from "./deviceExecution.js";

export class TaskWorkspaceError extends Error {
  constructor(
    readonly code:
      | "workspace_conflict"
      | "workspace_not_ready"
      | "workspace_missing"
      | "task_not_found"
      | "project_mismatch"
      | "root_mismatch"
      | "invalid_journal",
    message: string,
  ) {
    super(message);
    this.name = "TaskWorkspaceError";
  }
}
type Workspace = typeof taskExecutionWorkspaces.$inferSelect;
function checkout(row: Workspace): TaskCheckoutInput {
  return {
    projectRoot: row.projectRoot,
    worktreePath: row.worktreePath,
    projectId: row.projectId,
    taskId: row.taskId,
    snapshotCommit: row.snapshotCommit,
  };
}
function assertPolicy(projectId: string, taskId: string): void {
  if (getPersonalExecutionBlock(projectId, taskId)) throw new PersonalExecutionDisabledError();
}
function samePath(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === "";
}

/** Host-only local state, deliberately absent from shared domain serializers. */
export function getTaskExecutionWorkspace(taskId: string): Workspace | null {
  return (
    getDb()
      .select()
      .from(taskExecutionWorkspaces)
      .where(eq(taskExecutionWorkspaces.taskId, taskId))
      .get() ?? null
  );
}

function requireWorkspace(taskId: string): Workspace {
  const row = getTaskExecutionWorkspace(taskId);
  if (!row)
    throw new TaskWorkspaceError(
      "workspace_missing",
      "The task has no registered execution workspace.",
    );
  assertPolicy(row.projectId, taskId);
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new TaskWorkspaceError("task_not_found", "The execution task no longer exists.");
  if (task.projectId !== row.projectId)
    throw new TaskWorkspaceError(
      "project_mismatch",
      "The task changed projects after workspace registration.",
    );
  if (
    row.state !== "preparing" &&
    (task.worktreePath !== row.worktreePath || task.branchName !== null)
  ) {
    throw new TaskWorkspaceError(
      "root_mismatch",
      "Task checkout metadata diverged from the registered workspace.",
    );
  }
  return row;
}

/** Called by execution guards before any Git/FS/runtime work. Existing standalone
 * tasks retain their supplied root; registered tasks always use their exact root.
 */
export function resolveRegisteredTaskRoot(
  taskId: string,
  suppliedRoot: string,
  projectId?: string,
): string {
  const found = getTaskExecutionWorkspace(taskId);
  if (!found) return suppliedRoot;
  const row = requireWorkspace(taskId);
  if (projectId && projectId !== row.projectId)
    throw new TaskWorkspaceError(
      "project_mismatch",
      "The runtime project does not own the task workspace.",
    );
  if (!samePath(suppliedRoot, row.projectRoot) && !samePath(suppliedRoot, row.worktreePath)) {
    throw new TaskWorkspaceError(
      "root_mismatch",
      "The supplied execution root does not belong to this task.",
    );
  }
  if (row.state !== "active" || !row.scopeJson)
    throw new TaskWorkspaceError(
      "workspace_not_ready",
      "The workspace must be active before another runtime can write.",
    );
  // Restore validates provenance without reclassifying current dirty files.
  restoreTaskChangeScope(row.scopeJson, checkout(row));
  return row.worktreePath;
}

/** Registration is explicit, for a fresh task. The preparing row precedes Git
 * creation; active + scope + task root commit together before any runner starts.
 * M1 personal policy is checked before the first DB or filesystem mutation.
 */
export function prepareTaskExecutionWorkspace(input: TaskCheckoutInput): Workspace {
  assertPolicy(input.projectId, input.taskId);
  const db = getDb();
  const initial = db.transaction((tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
    const project = tx.select().from(projects).where(eq(projects.id, input.projectId)).get();
    if (!task) throw new TaskWorkspaceError("task_not_found", "The task does not exist.");
    if (!project || task.projectId !== project.id)
      throw new TaskWorkspaceError("project_mismatch", "The task does not belong to this project.");
    if (!samePath(project.rootPath, input.projectRoot))
      throw new TaskWorkspaceError(
        "root_mismatch",
        "The source root must match the local project binding.",
      );
    const existing = tx
      .select()
      .from(taskExecutionWorkspaces)
      .where(eq(taskExecutionWorkspaces.taskId, input.taskId))
      .get();
    if (existing) {
      if (
        Object.entries(input).some(
          ([key, value]) => checkout(existing)[key as keyof TaskCheckoutInput] !== value,
        )
      ) {
        throw new TaskWorkspaceError(
          "workspace_conflict",
          "The task already has a different workspace or base snapshot.",
        );
      }
      return existing;
    }
    if (task.worktreePath || task.branchName)
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "An existing branch-bound task needs explicit migration before registration.",
      );
    tx.insert(taskExecutionWorkspaces)
      .values({ ...input, state: "preparing" })
      .run();
    return tx
      .select()
      .from(taskExecutionWorkspaces)
      .where(eq(taskExecutionWorkspaces.taskId, input.taskId))
      .get()!;
  });
  if (initial.state !== "preparing") {
    const existing = requireWorkspace(input.taskId);
    assertTaskCheckout(checkout(existing));
    return existing;
  }
  prepareTaskCheckout(input);
  const scope = beginTaskChangeScope(input, { requireClean: true });
  db.transaction((tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
    if (!task || task.projectId !== input.projectId || task.branchName || task.worktreePath)
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "Task binding changed during checkout preparation.",
      );
    const changed = tx
      .update(taskExecutionWorkspaces)
      .set({
        state: "active",
        scopeJson: serializeTaskChangeScope(scope),
        revision: initial.revision + 1,
      })
      .where(
        and(
          eq(taskExecutionWorkspaces.taskId, input.taskId),
          eq(taskExecutionWorkspaces.revision, initial.revision),
          eq(taskExecutionWorkspaces.state, "preparing"),
        ),
      )
      .run();
    if (changed.changes !== 1)
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "Another process registered this workspace.",
      );
    tx.update(tasks)
      .set({ worktreePath: input.worktreePath })
      .where(eq(tasks.id, input.taskId))
      .run();
  });
  return requireWorkspace(input.taskId);
}

export function prepareTaskWorkspaceCheckpoint(taskId: string, message: string): Workspace {
  assertTaskDeviceExecution(taskId);
  const row = requireWorkspace(taskId);
  if (row.state === "checkpoint_prepared" || row.state === "checkpointed") return row;
  if (row.state !== "active" || !row.scopeJson)
    throw new TaskWorkspaceError(
      "workspace_not_ready",
      "No saved pre-execution scope is available.",
    );
  const scope = restoreTaskChangeScope(row.scopeJson, checkout(row));
  const intent = prepareTaskCommit(scope, message);
  const changed = getDb()
    .update(taskExecutionWorkspaces)
    .set({
      state: "checkpoint_prepared",
      intentJson: serializeTaskCommitIntent(intent),
      revision: row.revision + 1,
    })
    .where(
      and(
        eq(taskExecutionWorkspaces.taskId, taskId),
        eq(taskExecutionWorkspaces.revision, row.revision),
        eq(taskExecutionWorkspaces.state, "active"),
      ),
    )
    .run();
  if (changed.changes !== 1)
    throw new TaskWorkspaceError(
      "workspace_conflict",
      "Another writer prepared the task checkpoint first.",
    );
  return requireWorkspace(taskId);
}

export function publishTaskWorkspaceCheckpoint(taskId: string): TaskCommitResult {
  assertTaskDeviceExecution(taskId);
  const row = requireWorkspace(taskId);
  if ((row.state !== "checkpoint_prepared" && row.state !== "checkpointed") || !row.intentJson)
    throw new TaskWorkspaceError(
      "workspace_not_ready",
      "A durable prepared checkpoint is required before publishing its Git ref.",
    );
  const intent = restoreTaskCommitIntent(row.intentJson, checkout(row));
  const result = publishTaskCommit(intent);
  if (row.state === "checkpointed") return result;
  const changed = getDb()
    .update(taskExecutionWorkspaces)
    .set({ state: "checkpointed", resultJson: JSON.stringify(result), revision: row.revision + 1 })
    .where(
      and(
        eq(taskExecutionWorkspaces.taskId, taskId),
        eq(taskExecutionWorkspaces.revision, row.revision),
        eq(taskExecutionWorkspaces.state, "checkpoint_prepared"),
      ),
    )
    .run();
  if (changed.changes !== 1)
    throw new TaskWorkspaceError(
      "workspace_conflict",
      "The Git checkpoint is published; reload its journal before acknowledging completion.",
    );
  return result;
}

export function checkpointTaskExecutionWorkspace(
  taskId: string,
  message: string,
): TaskCommitResult {
  prepareTaskWorkspaceCheckpoint(taskId, message);
  return publishTaskWorkspaceCheckpoint(taskId);
}

/** Reserve one successor path for one sealed workspace revision. The current
 * workspace stays sealed until code, context and the new scope are all ready. */
export function beginTaskWorkspaceContinuation(input: {
  id: string;
  taskId: string;
  snapshotId: string;
  worktreePath: string;
}) {
  const row = requireWorkspace(input.taskId);
  const db = getDb();
  const existing = db
    .select()
    .from(taskWorkspaceContinuations)
    .where(eq(taskWorkspaceContinuations.id, input.id))
    .get();
  if (existing) {
    if (
      existing.taskId !== input.taskId ||
      existing.snapshotId !== input.snapshotId ||
      existing.worktreePath !== input.worktreePath
    )
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "Continuation ID was already used with different arguments",
      );
    return existing;
  }
  if (!input.id || input.id.length > 200 || row.state !== "checkpointed")
    throw new TaskWorkspaceError(
      "workspace_not_ready",
      "Continue only from a completed checkpoint",
    );
  if (samePath(input.worktreePath, row.worktreePath))
    throw new TaskWorkspaceError("workspace_conflict", "Continuation requires a new checkout path");
  const result = publishTaskWorkspaceCheckpoint(row.taskId);
  const pack = verifyLocalCodeSnapshot(input.snapshotId, row.projectId, row.projectRoot);
  if (
    pack.descriptor.taskId !== row.taskId ||
    pack.descriptor.commitSha !== (result.commitSha ?? row.snapshotCommit)
  )
    throw new TaskWorkspaceError(
      "workspace_conflict",
      "The snapshot does not describe this workspace checkpoint",
    );
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(taskExecutionWorkspaces)
      .where(eq(taskExecutionWorkspaces.taskId, row.taskId))
      .get();
    if (!current || current.revision !== row.revision || current.state !== "checkpointed")
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "Workspace changed before continuation reservation",
      );
    const reserved = tx
      .select()
      .from(taskWorkspaceContinuations)
      .where(
        and(
          eq(taskWorkspaceContinuations.taskId, row.taskId),
          eq(taskWorkspaceContinuations.fromRevision, row.revision),
        ),
      )
      .get();
    if (reserved)
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "This checkpoint already has a reserved continuation",
      );
    const values = {
      ...input,
      fromRevision: row.revision,
      previousWorkspaceJson: JSON.stringify(row),
    };
    tx.insert(taskWorkspaceContinuations).values(values).run();
    return { ...values, activatedRevision: null };
  });
}

export function activateTaskWorkspaceContinuation(id: string): Workspace {
  const db = getDb();
  const continuation = db
    .select()
    .from(taskWorkspaceContinuations)
    .where(eq(taskWorkspaceContinuations.id, id))
    .get();
  if (!continuation)
    throw new TaskWorkspaceError("workspace_missing", "Continuation journal was not found");
  const row = requireWorkspace(continuation.taskId);
  if (continuation.activatedRevision !== null) {
    if (
      row.worktreePath !== continuation.worktreePath ||
      row.sourceSnapshotId !== continuation.snapshotId
    )
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "This continuation has already been superseded",
      );
    assertTaskCheckout(checkout(row));
    return row;
  }
  if (row.revision !== continuation.fromRevision || row.state !== "checkpointed")
    throw new TaskWorkspaceError("workspace_conflict", "Continuation source changed");
  const result = publishTaskWorkspaceCheckpoint(row.taskId);
  const pack = verifyLocalCodeSnapshot(continuation.snapshotId, row.projectId, row.projectRoot);
  if (
    pack.descriptor.taskId !== row.taskId ||
    pack.descriptor.commitSha !== (result.commitSha ?? row.snapshotCommit)
  )
    throw new TaskWorkspaceError(
      "workspace_conflict",
      "The snapshot is not the sealed task checkpoint",
    );
  const next: TaskCheckoutInput = {
    ...checkout(row),
    worktreePath: continuation.worktreePath,
    snapshotCommit: pack.descriptor.commitSha,
  };
  const task = db.select().from(tasks).where(eq(tasks.id, row.taskId)).get();
  if (!task || task.lockedBy || task.plan !== pack.context.plan.text)
    throw new TaskWorkspaceError(
      "workspace_not_ready",
      "Task must be idle and its plan must match the context snapshot",
    );
  const planPath = task.planPath
    ? relative(row.worktreePath, taskCheckoutFilePath(row.worktreePath, task.planPath))
        .split("\\")
        .join("/")
    : task.planPath;
  prepareTaskCheckout(next);
  installContextSnapshot({ checkout: next, package: pack });
  const scope = beginTaskChangeScope(next, {
    requireClean: true,
    contextPaths: pack.context.files
      .filter((file) => file.source === "portable")
      .map((file) => file.path),
  });
  publishTaskWorkspaceCheckpoint(row.taskId);
  db.transaction((tx) => {
    const currentTask = tx.select().from(tasks).where(eq(tasks.id, row.taskId)).get();
    if (
      !currentTask ||
      currentTask.projectId !== row.projectId ||
      currentTask.worktreePath !== row.worktreePath ||
      currentTask.branchName !== null ||
      currentTask.lockedBy ||
      currentTask.plan !== pack.context.plan.text
    )
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "Task changed while preparing the continuation",
      );
    const revision = row.revision + 1;
    const changed = tx
      .update(taskExecutionWorkspaces)
      .set({
        worktreePath: next.worktreePath,
        snapshotCommit: next.snapshotCommit,
        sourceSnapshotId: pack.id,
        state: "active",
        scopeJson: serializeTaskChangeScope(scope),
        intentJson: null,
        resultJson: null,
        revision,
      })
      .where(
        and(
          eq(taskExecutionWorkspaces.taskId, row.taskId),
          eq(taskExecutionWorkspaces.revision, row.revision),
          eq(taskExecutionWorkspaces.state, "checkpointed"),
        ),
      )
      .run();
    if (changed.changes !== 1)
      throw new TaskWorkspaceError(
        "workspace_conflict",
        "Another process activated this continuation",
      );
    tx.update(taskWorkspaceContinuations)
      .set({ activatedRevision: revision })
      .where(eq(taskWorkspaceContinuations.id, id))
      .run();
    tx.update(tasks)
      .set({
        worktreePath: next.worktreePath,
        planPath,
        sessionId: null,
        activeRuntimeStatus: null,
        activeRuntimeSelectionJson: null,
        autoQueueCommitStatus: null,
        autoQueueCommitBaseSha: next.snapshotCommit,
        commitSha: null,
        autoQueueCommitError: null,
        autoQueueCommitCompletedAt: null,
      })
      .where(eq(tasks.id, row.taskId))
      .run();
  });
  return requireWorkspace(row.taskId);
}

export function continueTaskExecutionWorkspace(
  input: Parameters<typeof beginTaskWorkspaceContinuation>[0],
): Workspace {
  beginTaskWorkspaceContinuation(input);
  return activateTaskWorkspaceContinuation(input.id);
}
