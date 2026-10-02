import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  canonicalJson,
  DeviceHandoffError,
  taskDeviceHandoffs,
  taskDeviceGrantHeads,
  taskDeviceRuns,
  tasks,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import { taskExecutionInputDigest, withTaskDeviceMutation } from "./deviceExecution.js";

const checkpointScope = new AsyncLocalStorage<string>();
export function handoffInputDigest(task: typeof tasks.$inferSelect): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        input: taskExecutionInputDigest(task),
        owner: task.executionOwner,
        ownershipRevision: task.ownershipRevision,
        worktreePath: task.worktreePath,
        planPath: task.planPath,
      }),
    )
    .digest("hex");
}

/** Private host capability: only checkpoint plumbing consults this context.
 * Runtime execution guards never accept it as an execution scope. */
export function withHandoffCheckpoint<T>(id: string, operation: () => T): T {
  return checkpointScope.run(id, operation);
}
export function withWorkspaceCheckpointMutation<T>(taskId: string, operation: () => T): T {
  const id = checkpointScope.getStore();
  if (!id) return withTaskDeviceMutation(taskId, operation, true);
  return getDb().transaction(() => {
    const transfer = getDb()
      .select()
      .from(taskDeviceHandoffs)
      .where(eq(taskDeviceHandoffs.id, id))
      .get();
    const head = getDb()
      .select()
      .from(taskDeviceGrantHeads)
      .where(eq(taskDeviceGrantHeads.taskId, taskId))
      .get();
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
    // Until process supervision is implemented, only a run-free manual task
    // can reach this capability. No boolean "force stop" bypass exists.
    const run = getDb()
      .select({ id: taskDeviceRuns.id })
      .from(taskDeviceRuns)
      .where(
        and(eq(taskDeviceRuns.taskId, taskId), eq(taskDeviceRuns.grantId, head?.grantId ?? "")),
      )
      .get();
    if (
      !transfer ||
      transfer.taskId !== taskId ||
      transfer.direction !== "outgoing" ||
      !["quiescing", "checkpointed"].includes(transfer.phase) ||
      !transfer.stopJson ||
      !head ||
      !["owned", "accepted"].includes(head.state) ||
      head.grantId !== transfer.expectedGrantId ||
      head.ownerDeviceId !== getLocalDevice().deviceId ||
      head.activeRunId ||
      run ||
      !task ||
      task.executionOwner !== "human" ||
      task.lockedBy ||
      task.sessionId
    )
      throw new DeviceHandoffError("handoff_stop_unproven");
    if (handoffInputDigest(task) !== transfer.inputDigest)
      throw new DeviceHandoffError("handoff_input_changed");
    return operation();
  });
}
