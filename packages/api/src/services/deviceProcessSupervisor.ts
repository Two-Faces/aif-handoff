import {
  createTaskDeviceProcessJournal,
  getTaskDeviceProcessRecovery,
  recordTaskDeviceProcessRecovery,
  assertTaskDeviceExecution,
  resolveRegisteredTaskRoot,
} from "@aif/data";
import {
  launchSupervisedProcess,
  recoverSupervisedProcess,
  type SupervisedProcessInput,
} from "@aif/runtime";

/** Internal host bridge. There is deliberately no route or automatic adapter
 * fallback. The caller must already hold the exact task's managed run scope. */
export async function startTaskDeviceProcess(
  taskId: string,
  input: Omit<SupervisedProcessInput, "onIdentity" | "onPrepared">,
) {
  const cwd = input.cwd;
  function assertRoot() {
    assertTaskDeviceExecution(taskId, cwd);
    resolveRegisteredTaskRoot(taskId, cwd);
  }
  assertRoot();
  const journal = createTaskDeviceProcessJournal(taskId);
  const child = await launchSupervisedProcess({
    ...input,
    cwd,
    onIdentity: async (identity) => {
      assertRoot();
      await journal.onIdentity(identity);
    },
    onPrepared: async (identity) => {
      assertRoot();
      await journal.onPrepared(identity);
    },
  });
  const completed = child.completed.then(async (evidence) => {
    await journal.onStopped(evidence);
    return evidence;
  });
  void completed.catch(() => undefined);
  return {
    ...child,
    journalId: journal.id,
    completed,
    stop: async () => {
      await child.stop();
      return completed;
    },
  };
}

/** Explicit local recovery verifies the exact saved native identity. It records
 * process cessation only; active run/grant/claim and handoff phase stay intact. */
export async function recoverTaskDeviceProcess(id: string) {
  const identity = getTaskDeviceProcessRecovery(id);
  const evidence = await recoverSupervisedProcess(identity);
  return recordTaskDeviceProcessRecovery(id, evidence);
}
