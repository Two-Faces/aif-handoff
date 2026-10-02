import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { canonicalJson, DeviceExecutionError, taskDeviceSessions, chatSessions } from "@aif/shared";
import { getDb } from "@aif/shared/server";
import {
  currentTaskDeviceBinding,
  getTaskDeviceGrant,
  withCurrentTaskDeviceMutation,
} from "./deviceExecution.js";
import { getTaskExecutionWorkspace } from "./taskWorkspaces.js";

export interface TaskDeviceRuntimeIdentity {
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  transport?: string | null;
}
type Binding = typeof taskDeviceSessions.$inferSelect;
type Scope = NonNullable<ReturnType<typeof currentTaskDeviceBinding>>;
const mismatch = (): never => {
  throw new DeviceExecutionError("run_session_mismatch");
};
const runtimeKey = (identity: TaskDeviceRuntimeIdentity) =>
  canonicalJson({
    runtimeId: identity.runtimeId,
    providerId: identity.providerId,
    profileId: identity.profileId ?? null,
    transport: identity.transport ?? null,
  });
const nativeKey = (id: string, key: string) =>
  `native:${createHash("sha256")
    .update(canonicalJson([key, id]))
    .digest("hex")}`;
function find(key: string) {
  return getDb().select().from(taskDeviceSessions).where(eq(taskDeviceSessions.key, key)).get();
}
function matches(row: Binding, scope: Scope) {
  return (
    row.taskId === scope.taskId &&
    row.projectId === scope.projectId &&
    row.grantId === scope.grantId &&
    row.worktreePath === scope.worktreePath &&
    row.snapshotCommit === scope.snapshotCommit
  );
}
export function bindTaskDeviceChatSession(id: string, projectId: string): void {
  const scope = currentTaskDeviceBinding();
  if (!scope) return;
  if (scope.projectId !== projectId) mismatch();
  getDb()
    .insert(taskDeviceSessions)
    .values({ ...scope, key: `chat:${id}`, kind: "chat" })
    .run();
}
/** Validate before reserving a run: an unbound/foreign/retired chat cannot poison
 * a fresh task reservation or resume a native conversation from another root. */
export function assertTaskDeviceChatSession(input: {
  projectId: string;
  taskId?: string | null;
  sessionId?: string | null;
  nativeSessionId?: string | null;
}): void {
  if (!input.sessionId) return;
  const row = find(`chat:${input.sessionId}`);
  const head = input.taskId ? getTaskDeviceGrant(input.taskId) : null;
  const chat = getDb()
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, input.sessionId))
    .get();
  const nativeId = input.nativeSessionId ?? chat?.runtimeSessionId ?? chat?.agentSessionId;
  if (
    nativeId &&
    !row &&
    getDb()
      .select({ key: taskDeviceSessions.key })
      .from(taskDeviceSessions)
      .where(eq(taskDeviceSessions.nativeSessionId, nativeId))
      .limit(1)
      .get()
  )
    mismatch();
  if (!row && !head) return;
  const workspace = input.taskId ? getTaskExecutionWorkspace(input.taskId) : null;
  if (
    !row ||
    !head ||
    !workspace ||
    !matches(row, {
      taskId: head.taskId,
      projectId: input.projectId,
      grantId: head.grantId,
      worktreePath: workspace.worktreePath,
      snapshotCommit: workspace.snapshotCommit,
    })
  )
    mismatch();
}
/** Titles remain local UI metadata. Native links and generated history must
 * come from the current task execution, never an unscoped session writer. */
export function assertTaskDeviceChatRuntimeWrite(id: string): void {
  const row = find(`chat:${id}`);
  const scope = currentTaskDeviceBinding();
  if (!row) {
    if (scope) mismatch();
    return;
  }
  if (!scope || !matches(row, scope)) mismatch();
}
export function recordTaskDeviceNativeSession(
  id: string | null | undefined,
  identity: TaskDeviceRuntimeIdentity,
): void {
  if (!id) return;
  withCurrentTaskDeviceMutation(() => {
    const scope = currentTaskDeviceBinding();
    if (!scope) return;
    const key = runtimeKey(identity),
      existing = find(nativeKey(id, key));
    if (existing) {
      if (!matches(existing, scope)) mismatch();
      return;
    }
    getDb()
      .insert(taskDeviceSessions)
      .values({
        ...scope,
        key: nativeKey(id, key),
        kind: "native",
        nativeSessionId: id,
        runtimeKey: key,
      })
      .run();
  });
}
export function recordTaskDeviceRuntimeEvent(
  event: { type: string; data?: Record<string, unknown> },
  identity: TaskDeviceRuntimeIdentity,
): void {
  if (event.type === "system:init" && typeof event.data?.sessionId === "string")
    recordTaskDeviceNativeSession(event.data.sessionId, identity);
}
export function canResumeTaskDeviceSession(
  taskId: string,
  id: string,
  identity?: TaskDeviceRuntimeIdentity,
): boolean {
  if (!getTaskDeviceGrant(taskId))
    return !getDb()
      .select({ key: taskDeviceSessions.key })
      .from(taskDeviceSessions)
      .where(eq(taskDeviceSessions.nativeSessionId, id))
      .limit(1)
      .get();
  const scope = currentTaskDeviceBinding();
  if (!scope || scope.taskId !== taskId || !identity) return false;
  const row = find(nativeKey(id, runtimeKey(identity)));
  return Boolean(row && matches(row, scope));
}
/** Protect legacy/virtual imports too: a native ID already bound to a managed
 * task is never an unscoped session just because the caller omits taskId. */
export function assertTaskDeviceNativeImport(id?: string | null): void {
  if (!id) return;
  const rows = getDb()
    .select()
    .from(taskDeviceSessions)
    .where(and(eq(taskDeviceSessions.kind, "native"), eq(taskDeviceSessions.nativeSessionId, id)))
    .all();
  if (!rows.length) return;
  const scope = currentTaskDeviceBinding();
  if (!scope || rows.some((row) => !matches(row, scope))) mismatch();
}
export function assertTaskDeviceChatProject(id: string, projectId: string): void {
  const row = getDb()
    .select({ projectId: chatSessions.projectId })
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .get();
  if (row && row.projectId !== projectId) mismatch();
}

/** Read-only history/attachment lookup retains the original checkout even
 * after the task has continued elsewhere; it confers no execution scope. */
export function getTaskDeviceChatRoot(id: string, projectId: string): string | null {
  const row = find(`chat:${id}`);
  if (row && row.projectId !== projectId) mismatch();
  return row?.worktreePath ?? null;
}
