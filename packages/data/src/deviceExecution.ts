import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  canonicalJson,
  DeviceExecutionError,
  PersonalExecutionDisabledError,
  taskDeviceGrantSchema,
  taskDeviceGrants,
  taskDeviceGrantHeads,
  taskDeviceRuns,
  tasks,
  projects,
  type TaskDeviceGrant,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import { getPersonalExecutionBlock } from "./personalMode.js";
import { requirePeerProject } from "./peers.js";
import { readSyncVersions } from "./syncJournal.js";
import { getTaskExecutionWorkspace, resolveRegisteredTaskRoot } from "./taskWorkspaces.js";

type Head = typeof taskDeviceGrantHeads.$inferSelect;
type Run = typeof taskDeviceRuns.$inferSelect;
interface ExecutionScope {
  run: Readonly<Run>;
  pending: number;
  failed: boolean;
}
const execution = new AsyncLocalStorage<ExecutionScope>();
const samePath = (a: string, b: string) => relative(resolve(a), resolve(b)) === "";
const fail = (code: DeviceExecutionError["code"]): never => {
  throw new DeviceExecutionError(code);
};
const grantId = (grant: TaskDeviceGrant) =>
  createHash("sha256").update(canonicalJson(grant)).digest("hex");

export function getTaskDeviceGrant(taskId: string): Head | null {
  return (
    getDb()
      .select()
      .from(taskDeviceGrantHeads)
      .where(eq(taskDeviceGrantHeads.taskId, taskId))
      .get() ?? null
  );
}
export function getTaskDeviceRun(runId: string): Run | null {
  return getDb().select().from(taskDeviceRuns).where(eq(taskDeviceRuns.id, runId)).get() ?? null;
}
function requireTask(taskId: string) {
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task?.projectId) return fail("grant_invalid");
  return task;
}
function inputDigest(task: typeof tasks.$inferSelect): string {
  const keys = [
    "title",
    "description",
    "plan",
    "status",
    "paused",
    "autoMode",
    "runtimeProfileId",
    "modelOverride",
    "runtimeOptionsJson",
    "isFix",
    "useSubagents",
    "runPlanImprove",
    "runPostVerify",
    "planTests",
    "planDocs",
    "skipReview",
    "plannerMode",
  ] as const;
  return createHash("sha256")
    .update(canonicalJson(Object.fromEntries(keys.map((key) => [key, task[key]]))))
    .digest("hex");
}
function parseGrant(value: unknown): TaskDeviceGrant {
  const parsed = taskDeviceGrantSchema.safeParse(value);
  return parsed.success ? parsed.data : fail("grant_invalid");
}
function storedGrant(row: typeof taskDeviceGrants.$inferSelect): TaskDeviceGrant {
  let value: unknown;
  try {
    value = JSON.parse(row.grantJson);
  } catch {
    return fail("grant_invalid");
  }
  const grant = parseGrant(value);
  if (
    grantId(grant) !== row.id ||
    grant.taskId !== row.taskId ||
    grant.projectId !== row.projectId ||
    grant.executionEpoch !== row.executionEpoch ||
    grant.predecessorId !== row.predecessorId
  )
    return fail("grant_invalid");
  return grant;
}
function insertGrant(grant: TaskDeviceGrant): string {
  const id = grantId(grant);
  getDb()
    .insert(taskDeviceGrants)
    .values({
      id,
      taskId: grant.taskId,
      projectId: grant.projectId,
      executionEpoch: grant.executionEpoch,
      predecessorId: grant.predecessorId,
      grantJson: canonicalJson(grant),
    })
    .run();
  return id;
}

/** Host-only explicit enrollment. A replicated task's creator is its genesis
 * owner on EVERY replica. Neither the receiving device nor desired platform wins.
 * Standalone enrollment is restricted to a paused, never-started backlog task.
 */
export function initializeTaskDeviceGrant(taskId: string): Head {
  return getDb().transaction(() => {
    const task = requireTask(taskId);
    const existing = getTaskDeviceGrant(taskId);
    if (existing) {
      if (existing.projectId !== task.projectId) return fail("grant_conflict");
      return existing;
    }
    const project = getDb().select().from(projects).where(eq(projects.id, task.projectId!)).get();
    if (!project) return fail("grant_invalid");
    const versions = readSyncVersions(project.id, "task", taskId);
    let ownerDeviceId = getLocalDevice().deviceId;
    if (project.personalMode || versions.__created) {
      const created = versions.__created;
      if (!created || created.length !== 1 || versions.__deleted) return fail("grant_conflict");
      const [projectId, deviceId, incarnation, extra] = created[0].dot.streamKey.split(":");
      if (projectId !== project.id || !deviceId || !incarnation || extra)
        return fail("grant_invalid");
      ownerDeviceId = deviceId;
    } else if (!task.paused || task.status !== "backlog" || task.sessionId || task.lockedBy) {
      return fail("grant_not_ready");
    }
    const grant = parseGrant({
      version: 1,
      projectId: project.id,
      taskId,
      ownerDeviceId,
      executionEpoch: 0,
      predecessorId: null,
      issuerDeviceId: ownerDeviceId,
      transferId: null,
      snapshotId: null,
    });
    const id = insertGrant(grant);
    getDb()
      .insert(taskDeviceGrantHeads)
      .values({
        taskId,
        projectId: project.id,
        grantId: id,
        ownerDeviceId,
        executionEpoch: 0,
        state: ownerDeviceId === getLocalDevice().deviceId ? "owned" : "observed",
      })
      .run();
    return getTaskDeviceGrant(taskId)!;
  });
}

/** P14 must first durably record a verified stop + exact checkpoint release.
 * There is deliberately no public writer for that proof in P13. An expired lock,
 * an abort signal, and an ordinary board mutation cannot reach this transition.
 */
export function issueTaskDeviceSuccessor(input: {
  taskId: string;
  expectedGrantId: string;
  targetDeviceId: string;
  transferId: string;
  snapshotId: string;
}): TaskDeviceGrant {
  return getDb().transaction(() => {
    const old = getDb()
      .select()
      .from(taskDeviceGrants)
      .where(eq(taskDeviceGrants.id, input.expectedGrantId))
      .get();
    if (!old || old.taskId !== input.taskId) return fail("grant_missing");
    const parent = storedGrant(old);
    if (parent.ownerDeviceId !== getLocalDevice().deviceId) return fail("grant_not_owned");
    requirePeerProject(input.targetDeviceId, parent.projectId);
    const next = parseGrant({
      ...parent,
      executionEpoch: parent.executionEpoch + 1,
      predecessorId: old.id,
      issuerDeviceId: parent.ownerDeviceId,
      ownerDeviceId: input.targetDeviceId,
      transferId: input.transferId,
      snapshotId: input.snapshotId,
    });
    const previous = getDb()
      .select()
      .from(taskDeviceGrants)
      .where(eq(taskDeviceGrants.predecessorId, old.id))
      .get();
    if (previous) return previous.id === grantId(next) ? next : fail("grant_conflict");
    const head = getTaskDeviceGrant(input.taskId);
    if (
      !head ||
      head.grantId !== old.id ||
      head.state !== "released" ||
      head.activeRunId ||
      head.releasedTransferId !== input.transferId ||
      head.releasedSnapshotId !== input.snapshotId
    )
      return fail("release_not_proven");
    const id = insertGrant(next);
    getDb()
      .update(taskDeviceGrantHeads)
      .set({
        grantId: id,
        ownerDeviceId: next.ownerDeviceId,
        executionEpoch: next.executionEpoch,
        state: "observed",
        releasedTransferId: null,
        releasedSnapshotId: null,
      })
      .where(eq(taskDeviceGrantHeads.taskId, input.taskId))
      .run();
    return next;
  });
}

/** Only a direct authenticated issuer is accepted; relayed/unknown ancestry is
 * rejected. Receipt stages authority but does NOT accept it or start execution.
 */
export function receiveTaskDeviceSuccessor(peerDeviceId: string, value: unknown): Head {
  const grant = parseGrant(value);
  requirePeerProject(peerDeviceId, grant.projectId);
  if (
    grant.issuerDeviceId !== peerDeviceId ||
    grant.ownerDeviceId !== getLocalDevice().deviceId ||
    !grant.predecessorId
  )
    return fail("grant_invalid");
  const result = getDb().transaction(() => {
    const task = requireTask(grant.taskId);
    if (task.projectId !== grant.projectId) return fail("grant_invalid");
    const parentRow = getDb()
      .select()
      .from(taskDeviceGrants)
      .where(eq(taskDeviceGrants.id, grant.predecessorId!))
      .get();
    if (!parentRow) return fail("grant_missing");
    const parent = storedGrant(parentRow);
    if (
      parent.taskId !== grant.taskId ||
      parent.projectId !== grant.projectId ||
      parent.ownerDeviceId !== peerDeviceId ||
      parent.executionEpoch + 1 !== grant.executionEpoch
    )
      return fail("grant_invalid");
    const head = getTaskDeviceGrant(grant.taskId);
    if (!head) return fail("grant_missing");
    const existing = getDb()
      .select()
      .from(taskDeviceGrants)
      .where(
        and(
          eq(taskDeviceGrants.taskId, grant.taskId),
          eq(taskDeviceGrants.executionEpoch, grant.executionEpoch),
        ),
      )
      .get();
    if (existing) {
      if (existing.id === grantId(grant)) return head;
      // Commit quarantine before reporting the fork (throwing inside rolls it back).
      getDb()
        .update(taskDeviceGrantHeads)
        .set({ state: "conflicted" })
        .where(eq(taskDeviceGrantHeads.taskId, grant.taskId))
        .run();
      return null;
    }
    if (head.grantId !== parentRow.id || head.state !== "observed" || head.activeRunId)
      return fail("grant_not_ready");
    const id = insertGrant(grant);
    getDb()
      .update(taskDeviceGrantHeads)
      .set({
        grantId: id,
        ownerDeviceId: grant.ownerDeviceId,
        executionEpoch: grant.executionEpoch,
        state: "pending",
      })
      .where(eq(taskDeviceGrantHeads.taskId, grant.taskId))
      .run();
    return getTaskDeviceGrant(grant.taskId)!;
  });
  return result ?? fail("grant_conflict");
}

function assertRun(run: Readonly<Run>, taskId: string, root?: string): void {
  const head = getTaskDeviceGrant(taskId);
  const saved = getTaskDeviceRun(run.id);
  const task = requireTask(taskId);
  const workspace = getTaskExecutionWorkspace(taskId);
  if (
    run.taskId !== taskId ||
    !head ||
    head.state !== "owned" ||
    head.activeRunId !== run.id ||
    head.ownerDeviceId !== getLocalDevice().deviceId ||
    head.ownerDeviceId !== run.ownerDeviceId ||
    head.executionEpoch !== run.executionEpoch ||
    head.grantId !== run.grantId ||
    saved?.state !== "running" ||
    task.projectId !== head.projectId ||
    task.executionOwner !== "ai" ||
    task.ownershipRevision !== run.ownershipRevision ||
    saved.inputDigest !== inputDigest(task) ||
    !workspace ||
    workspace.worktreePath !== run.worktreePath ||
    workspace.snapshotCommit !== run.snapshotCommit ||
    task.worktreePath !== run.worktreePath ||
    task.branchName !== null
  )
    return fail("run_fenced");
  if (root && !samePath(root, run.worktreePath)) return fail("run_root_mismatch");
  if (getPersonalExecutionBlock(head.projectId, taskId)) throw new PersonalExecutionDisabledError();
}

/** Called at launch/result boundaries. Managed tasks require the host-created
 * async scope; a caller-supplied owner/epoch/runId tuple is never a capability.
 */
export function assertTaskDeviceExecution(taskId: string, root?: string): void {
  const current = execution.getStore();
  if (current) return assertRun(current.run, taskId, root);
  if (getTaskDeviceGrant(taskId)) return fail("run_scope_required");
}
function hasManagedProject(projectId: string): boolean {
  return !!getDb()
    .select({ id: taskDeviceGrantHeads.taskId })
    .from(taskDeviceGrantHeads)
    .where(eq(taskDeviceGrantHeads.projectId, projectId))
    .limit(1)
    .get();
}
export function assertTasklessDeviceExecution(projectId: string): void {
  if (execution.getStore() || hasManagedProject(projectId))
    return fail("taskless_execution_denied");
}
export function assertProjectDeviceExecution(
  projectId: string,
  taskId?: string | null,
  root?: string,
): void {
  if (!taskId) return assertTasklessDeviceExecution(projectId);
  const head = getTaskDeviceGrant(taskId);
  if (head && head.projectId !== projectId) return fail("run_fenced");
  if (!head && hasManagedProject(projectId)) return fail("grant_missing");
  assertTaskDeviceExecution(taskId, root);
}

/** Structured preflight for APIs that return errors instead of throwing. */
export function getDeviceExecutionBlock(projectId: string, taskId?: string | null) {
  try {
    assertProjectDeviceExecution(projectId, taskId);
    return null;
  } catch (error) {
    if (error instanceof DeviceExecutionError) return { code: error.code, error: error.message };
    throw error;
  }
}

/** Check and mutate under the SAME SQLite transaction. Board edits outside a
 * runtime scope remain possible; internal execution writers require a scope.
 */
export function withTaskDeviceMutation<T>(
  taskId: string,
  mutate: () => T,
  requireScope = false,
): T {
  if (!execution.getStore() && !requireScope) return mutate();
  return getDb().transaction(() => {
    assertTaskDeviceExecution(taskId);
    const result = mutate();
    const current = execution.getStore();
    if (current)
      getDb()
        .update(taskDeviceRuns)
        .set({ inputDigest: inputDigest(requireTask(taskId)) })
        .where(eq(taskDeviceRuns.id, current.run.id))
        .run();
    return result;
  });
}

/** Internal runner integration point. Existing standalone tasks are unchanged.
 * Failure/timeout retains the reservation as uncertain. P14 must prove exit to
 * recover it; neither elapsed time nor a fresh coordinator can steal the run.
 */
export async function withTaskDeviceExecution<T>(
  input: {
    taskId: string;
    projectRoot: string;
    coordinatorId?: string;
  },
  execute: (root: string) => Promise<T>,
): Promise<T> {
  const task = requireTask(input.taskId);
  if (getPersonalExecutionBlock(task.projectId!, task.id))
    throw new PersonalExecutionDisabledError();
  const head = getTaskDeviceGrant(task.id);
  if (!head && !execution.getStore()) return execute(input.projectRoot);
  const root = resolveRegisteredTaskRoot(task.id, input.projectRoot, task.projectId!);
  const inherited = execution.getStore();
  if (inherited) {
    assertRun(inherited.run, task.id, root);
    inherited.pending++;
    try {
      const result = await execute(root);
      assertRun(inherited.run, task.id, root);
      return result;
    } catch (error) {
      inherited.failed = true;
      throw error;
    } finally {
      inherited.pending--;
    }
  }
  const run = getDb().transaction(() => {
    const current = getTaskDeviceGrant(task.id);
    if (!current) return fail("grant_missing");
    if (current.state !== "owned") return fail("grant_not_ready");
    if (current.ownerDeviceId !== getLocalDevice().deviceId) return fail("grant_not_owned");
    if (current.activeRunId) return fail("run_busy");
    const fresh = requireTask(task.id);
    if (fresh.projectId !== current.projectId || fresh.executionOwner !== "ai")
      return fail("run_fenced");
    if (
      fresh.lockedBy &&
      (fresh.lockedBy !== input.coordinatorId ||
        !fresh.lockedUntil ||
        fresh.lockedUntil <= new Date().toISOString())
    )
      return fail("run_busy");
    if (input.coordinatorId && fresh.lockedBy !== input.coordinatorId) return fail("run_fenced");
    const workspace = getTaskExecutionWorkspace(task.id);
    if (!workspace || workspace.state !== "active" || !samePath(root, workspace.worktreePath))
      return fail("run_root_mismatch");
    const record: Run = {
      id: randomUUID(),
      taskId: task.id,
      grantId: current.grantId,
      ownerDeviceId: current.ownerDeviceId,
      executionEpoch: current.executionEpoch,
      worktreePath: root,
      snapshotCommit: workspace.snapshotCommit,
      ownershipRevision: fresh.ownershipRevision,
      inputDigest: inputDigest(fresh),
      state: "running",
      startedAt: new Date().toISOString(),
      settledAt: null,
    };
    getDb().insert(taskDeviceRuns).values(record).run();
    getDb()
      .update(taskDeviceGrantHeads)
      .set({ activeRunId: record.id })
      .where(eq(taskDeviceGrantHeads.taskId, task.id))
      .run();
    return Object.freeze(record);
  });
  const scope: ExecutionScope = { run, pending: 0, failed: false };
  return execution.run(scope, async () => {
    try {
      const result = await execute(root);
      getDb().transaction(() => {
        if (scope.pending || scope.failed) return fail("run_fenced");
        assertRun(run, task.id);
        getDb()
          .update(taskDeviceRuns)
          .set({ state: "settled", settledAt: new Date().toISOString() })
          .where(eq(taskDeviceRuns.id, run.id))
          .run();
        getDb()
          .update(taskDeviceGrantHeads)
          .set({ activeRunId: null })
          .where(
            and(
              eq(taskDeviceGrantHeads.taskId, task.id),
              eq(taskDeviceGrantHeads.activeRunId, run.id),
            ),
          )
          .run();
      });
      return result;
    } catch (error) {
      getDb()
        .update(taskDeviceRuns)
        .set({ state: "uncertain" })
        .where(and(eq(taskDeviceRuns.id, run.id), eq(taskDeviceRuns.state, "running")))
        .run();
      throw error;
    }
  });
}

/** Event emitters may invoke callbacks outside their original async context. */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
export function bindTaskDeviceExecution<T extends unknown[], R>(
  callback: (...args: T) => R,
): (...args: T) => R {
  const scope = execution.getStore();
  if (!scope) return callback;
  return (...args) =>
    execution.run(scope, () => {
      assertRun(scope.run, scope.run.taskId);
      const result = callback(...args);
      if (!isPromiseLike(result)) return result;
      scope.pending++;
      return Promise.resolve(result)
        .then((value) => {
          assertRun(scope.run, scope.run.taskId);
          return value;
        })
        .catch((error: unknown) => {
          scope.failed = true;
          throw error;
        })
        .finally(() => {
          scope.pending--;
        }) as R;
    });
}

/** P13 rollout stays closed for managed tasks until all runner scopes and P14
 * process-stop recovery are wired. SQL exclusion happens BEFORE queue limits.
 */
export function unmanagedTaskExecutionFilter() {
  return sql`NOT EXISTS (SELECT 1 FROM ${taskDeviceGrantHeads} WHERE ${taskDeviceGrantHeads.taskId} = ${tasks.id})`;
}
