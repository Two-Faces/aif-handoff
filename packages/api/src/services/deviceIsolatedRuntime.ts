import { findTaskById, getTaskExecutionWorkspace, withTaskDeviceNativeExecution } from "@aif/data";
import { RuntimeExecutionError, type RuntimeRunInput } from "@aif/runtime";
import {
  runTaskDeviceClaudeApi,
  runTaskDeviceClaudeCli,
  runTaskDeviceClaudeSdk,
  runTaskDeviceHttp,
  runTaskDeviceOpenCode,
} from "./deviceProcessSupervisor.js";

function invalid(): never {
  throw new RuntimeExecutionError(
    "Whole-run native admission is not available for this input",
    undefined,
    "permission",
    { adapterCode: "native_run_admission_invalid" },
  );
}

/** Internal whole invocation. No caller-owned host callbacks, nested workflows,
 * session reuse or configurable external executor can acquire this admission.
 * Personal execution and normal coordinator admission remain disabled. */
export function executeTaskDeviceIsolatedRuntime(taskId: string, input: RuntimeRunInput) {
  const allowedExecution = new Set([
    "abortController",
    "maxBudgetUsd",
    "maxTurns",
    "startTimeoutMs",
    "runTimeoutMs",
    "includePartialMessages",
    "systemPromptAppend",
  ]);
  if (
    Object.keys(input.execution ?? {}).some((key) => !allowedExecution.has(key)) ||
    input.sessionId ||
    input.resume ||
    "sourceSessionId" in input
  )
    invalid();
  let run: typeof runTaskDeviceOpenCode | undefined;
  if (input.runtimeId === "claude") {
    if (input.transport === "sdk") run = runTaskDeviceClaudeSdk;
    if (input.transport === "api") run = runTaskDeviceClaudeApi;
    if (input.transport === "cli") run = runTaskDeviceClaudeCli;
  } else if (input.transport === "api") {
    if (input.runtimeId === "opencode") run = runTaskDeviceOpenCode;
    if (["codex", "openrouter"].includes(input.runtimeId)) run = runTaskDeviceHttp;
  }
  if (!run) return invalid();
  const task = findTaskById(taskId),
    workspace = getTaskExecutionWorkspace(taskId);
  const root = input.cwd ?? input.projectRoot;
  if (
    !task ||
    !workspace ||
    root !== workspace.worktreePath ||
    (input.projectRoot !== undefined && input.projectRoot !== root) ||
    input.usageContext.taskId !== task.id ||
    input.usageContext.projectId !== task.projectId
  )
    return invalid();
  // Snapshot options before the first await; later caller edits cannot turn the
  // admitted invocation into another transport or attach a host callback.
  const abortController = input.execution?.abortController;
  let saved: RuntimeRunInput;
  try {
    saved = structuredClone({
      ...input,
      execution: { ...input.execution, abortController: undefined },
    });
  } catch {
    return invalid();
  }
  saved.execution = { ...saved.execution, abortController };
  return withTaskDeviceNativeExecution(
    {
      taskId,
      projectRoot: workspace.projectRoot,
      runtimeId: saved.runtimeId,
      transport: saved.transport!,
    },
    () => run(taskId, saved),
  );
}
