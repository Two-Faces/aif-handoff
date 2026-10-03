import {
  createTaskDeviceProcessJournal,
  getTaskDeviceProcessRecovery,
  recordTaskDeviceProcessRecovery,
  assertTaskDeviceExecution,
  resolveRegisteredTaskRoot,
  currentTaskDeviceRunId,
  findTaskById,
  createDbUsageSink,
  createTaskDeviceRuntimeGuard,
} from "@aif/data";
import {
  launchSupervisedProcess,
  recoverSupervisedProcess,
  withNativeProcessScope,
  bootstrapRuntimeRegistry,
  RuntimeExecutionError,
  RuntimeTransport,
  type RuntimeRunInput,
  type RuntimeSessionForkInput,
  type SupervisedProcessInput,
} from "@aif/runtime";

/** Internal P14 transport integration, deliberately not called from routes or
 * the worker yet. Host enrollment, exact root and personal policy are mandatory.
 * Resume/configured external-service coverage remains a separate admission gate. */
export async function runTaskDeviceAppServer(taskId: string, input: RuntimeRunInput) {
  return runTaskDeviceCodex(taskId, input, RuntimeTransport.APP_SERVER);
}

/** Internal CLI increment; same task/run/personal gates as app-server. */
export async function runTaskDeviceCli(taskId: string, input: RuntimeRunInput) {
  return runTaskDeviceCodex(taskId, input, RuntimeTransport.CLI);
}

async function runTaskDeviceCodex(
  taskId: string,
  input: RuntimeRunInput,
  transport: typeof RuntimeTransport.APP_SERVER | typeof RuntimeTransport.CLI,
) {
  const root = input.cwd ?? input.projectRoot;
  assertTaskDeviceExecution(taskId, root);
  const task = findTaskById(taskId);
  const reusesSession = Boolean(
    input.sessionId || input.resume || (input as Partial<RuntimeSessionForkInput>).sourceSessionId,
  );
  const scopeMismatch =
    !currentTaskDeviceRunId() ||
    !task ||
    !root ||
    input.usageContext.taskId !== taskId ||
    input.usageContext.projectId !== task.projectId ||
    (input.projectRoot !== undefined && input.projectRoot !== root);
  if (
    scopeMismatch ||
    input.runtimeId !== "codex" ||
    input.transport !== transport ||
    reusesSession ||
    (transport === RuntimeTransport.CLI && input.options?.codexCliArgs !== undefined)
  ) {
    throw new RuntimeExecutionError(
      "Native task runtime input is not admissible",
      undefined,
      "permission",
      { adapterCode: "native_task_input_invalid" },
    );
  }
  resolveRegisteredTaskRoot(taskId, root);
  const registry = await bootstrapRuntimeRegistry({ usageSink: createDbUsageSink() });
  const adapter = registry.resolveRuntime("codex");
  const guard = createTaskDeviceRuntimeGuard(taskId, input.execution?.abortController);
  const execution = { ...input.execution, abortController: guard.abortController };
  if (execution.onEvent) execution.onEvent = guard.bind(execution.onEvent);
  if (execution.onToolUse) execution.onToolUse = guard.bind(execution.onToolUse);
  if (execution.onSubagentStart) execution.onSubagentStart = guard.bind(execution.onSubagentStart);
  if (execution.onStderr) execution.onStderr = guard.bind(execution.onStderr);
  return guard.run(() =>
    withNativeProcessScope(
      root,
      (launch) => startTaskDeviceProcess(taskId, launch),
      (scope) => adapter.run({ ...input, execution: { ...execution, nativeProcessScope: scope } }),
    ),
  );
}

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
