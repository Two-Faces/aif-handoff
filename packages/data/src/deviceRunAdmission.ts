import { eq } from "drizzle-orm";
import { DeviceHandoffError, taskDeviceRunAdmissions } from "@aif/shared";
import { getDb } from "@aif/shared/server";

export interface TaskDeviceNativeAdmission {
  runtimeId: string;
  transport: string;
}
export const nativeAdmissionPolicy = "isolated_runtime_v1";

/** Codex CLI/SDK/app-server still inherit configuration. A native tree alone
 * cannot attest external MCP executors. Admit only explicitly isolated paths. */
export function isTaskDeviceNativeAdmission(value: TaskDeviceNativeAdmission): boolean {
  return value.runtimeId === "claude"
    ? ["sdk", "cli", "api"].includes(value.transport)
    : ["codex", "openrouter", "opencode"].includes(value.runtimeId) && value.transport === "api";
}

export function getTaskDeviceRunAdmission(runId: string) {
  return getDb()
    .select()
    .from(taskDeviceRunAdmissions)
    .where(eq(taskDeviceRunAdmissions.runId, runId))
    .get();
}

export function requireTaskDeviceRunAdmission(runId: string) {
  const admission = getTaskDeviceRunAdmission(runId);
  if (
    !admission ||
    admission.policy !== nativeAdmissionPolicy ||
    !isTaskDeviceNativeAdmission(admission)
  )
    throw new DeviceHandoffError("handoff_stop_unproven");
  return admission;
}
