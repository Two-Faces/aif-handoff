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
  return runTaskDeviceRuntime(taskId, input, RuntimeTransport.APP_SERVER);
}

/** Internal CLI increment; same task/run/personal gates as app-server. */
export async function runTaskDeviceCli(taskId: string, input: RuntimeRunInput) {
  return runTaskDeviceRuntime(taskId, input, RuntimeTransport.CLI);
}

/** Internal SDK worker increment; no public route or automatic admission. */
export async function runTaskDeviceSdk(taskId: string, input: RuntimeRunInput) {
  return runTaskDeviceRuntime(taskId, input, RuntimeTransport.SDK);
}

/** Internal fresh Claude SDK worker; project config/external MCP admission is
 * deliberately deferred. Both providers share the durable task/run bridge. */
export async function runTaskDeviceClaudeSdk(taskId: string, input: RuntimeRunInput) {
  return runTaskDeviceRuntime(taskId, input, RuntimeTransport.SDK, "claude");
}

/** Claude's API transport uses the same Agent SDK process, with provider auth. */
export async function runTaskDeviceClaudeApi(taskId: string, input: RuntimeRunInput) {
  return runTaskDeviceRuntime(taskId, input, RuntimeTransport.API, "claude");
}

/** Direct Claude print-mode CLI inside the fixed native worker; no SDK fallback. */
export async function runTaskDeviceClaudeCli(taskId: string, input: RuntimeRunInput) {
  return runTaskDeviceRuntime(taskId, input, RuntimeTransport.CLI, "claude");
}

/** Text-only HTTP clients; this does not admit a remote OpenCode executor. */
export async function runTaskDeviceHttp(taskId: string, input: RuntimeRunInput) {
  if (input.runtimeId !== "codex" && input.runtimeId !== "openrouter")
    throw new RuntimeExecutionError(
      "Native HTTP runtime is not admissible",
      undefined,
      "permission",
      { adapterCode: "native_task_input_invalid" },
    );
  return runTaskDeviceRuntime(taskId, input, RuntimeTransport.API, input.runtimeId);
}

/** Fresh OpenCode server inside the native unit, never an existing API server. */
export async function runTaskDeviceOpenCode(taskId: string, input: RuntimeRunInput) {
  return runTaskDeviceRuntime(taskId, input, RuntimeTransport.API, "opencode");
}

async function runTaskDeviceRuntime(
  taskId: string,
  input: RuntimeRunInput,
  transport:
    | typeof RuntimeTransport.APP_SERVER
    | typeof RuntimeTransport.CLI
    | typeof RuntimeTransport.SDK
    | typeof RuntimeTransport.API,
  runtimeId: "codex" | "claude" | "openrouter" | "opencode" = "codex",
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
  const unsupportedClaudeOptions =
    runtimeId === "claude" &&
    (input.options?.claudeCliArgs !== undefined ||
      input.execution?.hooks !== undefined ||
      input.execution?.environment !== undefined ||
      input.execution?.outputSchema !== undefined ||
      input.execution?.bypassPermissions ||
      input.execution?.agentDefinitionName !== undefined);
  if (
    scopeMismatch ||
    input.runtimeId !== runtimeId ||
    input.transport !== transport ||
    reusesSession ||
    unsupportedClaudeOptions ||
    (transport === RuntimeTransport.CLI && input.options?.codexCliArgs !== undefined) ||
    (transport === RuntimeTransport.SDK &&
      (input.options?.codexCliArgs !== undefined ||
        input.options?.codexConfig !== undefined ||
        input.execution?.outputSchema !== undefined ||
        input.execution?.hooks !== undefined ||
        input.execution?.environment !== undefined))
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
  const adapter = registry.resolveRuntime(runtimeId);
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
