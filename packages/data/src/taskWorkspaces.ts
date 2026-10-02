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
  tasks,
  projects,
  PersonalExecutionDisabledError,
  type TaskCheckoutInput,
  type TaskCommitResult,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getPersonalExecutionBlock } from "./personalMode.js";

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
