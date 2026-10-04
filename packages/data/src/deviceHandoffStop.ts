import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  canonicalJson,
  DeviceHandoffError,
  taskDeviceRuns,
  taskDeviceProcesses,
  taskDeviceGrantHeads,
  processHostIdentitySchema,
  preparedProcessIdentitySchema,
  processStopEvidenceSchema,
  processHostIdentity,
  type taskDeviceHandoffs,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import { requireTaskDeviceRunAdmission } from "./deviceRunAdmission.js";

const fail = (): never => {
  throw new DeviceHandoffError("handoff_stop_unproven");
};
function parse(value: string | null): unknown {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return fail();
  }
}

/** One complete native invocation, including ingress validation of persisted
 * identities. An empty journal, old run or recovered reservation is not proof. */
export function assertNativeTaskDeviceRunStopped(run: typeof taskDeviceRuns.$inferSelect) {
  const admission = requireTaskDeviceRunAdmission(run.id);
  const processes = getDb()
    .select()
    .from(taskDeviceProcesses)
    .where(eq(taskDeviceProcesses.runId, run.id))
    .all();
  if (processes.length !== 1 || run.ownerDeviceId !== getLocalDevice().deviceId) return fail();
  const process = processes[0];
  const host = processHostIdentitySchema.safeParse(parse(process.identityJson));
  const prepared = preparedProcessIdentitySchema.safeParse(parse(process.preparedJson));
  const stop = processStopEvidenceSchema.safeParse(parse(process.evidenceJson));
  if (
    process.taskId !== run.taskId ||
    process.state !== "stopped" ||
    !process.stoppedAt ||
    !host.success ||
    !prepared.success ||
    !stop.success ||
    process.supervisorId !== host.data.id ||
    canonicalJson(host.data) !== canonicalJson(processHostIdentity(prepared.data)) ||
    canonicalJson(host.data) !== canonicalJson(processHostIdentity(stop.data.identity)) ||
    canonicalJson(stop.data.reason === "recovered" ? host.data : prepared.data) !==
      canonicalJson(stop.data.identity)
  )
    return fail();
  // Running -> uncertain/settled may finish after the handoff fence. Neither is
  // stop evidence; exclude those mutable bookkeeping fields from the proof.
  const { state: _state, settledAt: _settledAt, ...identity } = run;
  return { run: identity, admission, process };
}

export function taskNativeHandoffStopDigest(row: typeof taskDeviceHandoffs.$inferSelect): string {
  const head = getDb()
    .select()
    .from(taskDeviceGrantHeads)
    .where(eq(taskDeviceGrantHeads.taskId, row.taskId))
    .get();
  const runs = getDb()
    .select()
    .from(taskDeviceRuns)
    .where(
      and(eq(taskDeviceRuns.taskId, row.taskId), eq(taskDeviceRuns.grantId, row.expectedGrantId)),
    )
    .all()
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    !head ||
    head.grantId !== row.expectedGrantId ||
    !runs.length ||
    (head.activeRunId && !runs.some((run) => run.id === head.activeRunId))
  )
    return fail();
  const proof = runs.map((run) => {
    if (run.executionEpoch !== head.executionEpoch) return fail();
    return assertNativeTaskDeviceRunStopped(run);
  });
  return createHash("sha256").update(canonicalJson(proof)).digest("hex");
}

export function readHandoffStop(value: string | null): Record<string, unknown> {
  const raw = parse(value);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : fail();
}

export function assertNativeHandoffStop(row: typeof taskDeviceHandoffs.$inferSelect): void {
  const stop = readHandoffStop(row.stopJson);
  if (stop.kind !== "native" || stop.proofDigest !== taskNativeHandoffStopDigest(row)) fail();
}
