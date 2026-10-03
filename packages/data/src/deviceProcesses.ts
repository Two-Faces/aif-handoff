import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import {
  canonicalJson,
  ProcessJournalError,
  DeviceExecutionError,
  processHostIdentitySchema,
  preparedProcessIdentitySchema,
  processStopEvidenceSchema,
  taskDeviceProcesses,
  taskDeviceRuns,
  type ProcessHostIdentity,
  type PreparedProcessIdentity,
  type ProcessStopEvidence,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { assertTaskDeviceExecution, currentTaskDeviceRunId } from "./deviceExecution.js";
import { getLocalDevice } from "./devices.js";

function fail(code: ProcessJournalError["code"]): never {
  throw new ProcessJournalError(code);
}
export function getTaskDeviceProcess(id: string) {
  return (
    getDb().select().from(taskDeviceProcesses).where(eq(taskDeviceProcesses.id, id)).get() ??
    fail("process_missing")
  );
}
export function listTaskDeviceProcesses(runId: string) {
  return getDb()
    .select()
    .from(taskDeviceProcesses)
    .where(eq(taskDeviceProcesses.runId, runId))
    .all();
}
function originalHost(id: string) {
  const row = getTaskDeviceProcess(id);
  const run = getDb().select().from(taskDeviceRuns).where(eq(taskDeviceRuns.id, row.runId)).get();
  if (!run || run.taskId !== row.taskId || run.ownerDeviceId !== getLocalDevice().deviceId)
    fail("process_conflict");
  return row;
}
function hostOnly(): void {
  if (currentTaskDeviceRunId()) throw new DeviceExecutionError("run_scope_required");
}
function hostIdentity(value: ProcessHostIdentity | PreparedProcessIdentity): ProcessHostIdentity {
  const { version, mechanism, id, jobName, hostPid, hostSessionId, hostBirth } = value;
  return { version, mechanism, id, jobName, hostPid, hostSessionId, hostBirth };
}
function savedIdentity(json: string | null): ProcessHostIdentity {
  let value: unknown;
  try {
    value = json ? JSON.parse(json) : null;
  } catch {
    return fail("process_invalid");
  }
  const parsed = processHostIdentitySchema.safeParse(value);
  return parsed.success ? parsed.data : fail("process_invalid");
}
function saveStop(id: string, value: unknown, recovery: boolean) {
  const parsed = processStopEvidenceSchema.safeParse(value);
  if (!parsed.success || (parsed.data.reason === "recovered") !== recovery)
    return fail("process_invalid");
  const evidence = parsed.data;
  return getDb().transaction(() => {
    const row = originalHost(id);
    if (!row.identityJson || canonicalJson(hostIdentity(evidence.identity)) !== row.identityJson)
      fail("process_conflict");
    if (!recovery && (!row.preparedJson || canonicalJson(evidence.identity) !== row.preparedJson))
      fail("process_conflict");
    if (row.state === "stopped") {
      // Keep the original proof, including its normal exit code. Recovery can
      // verify the same already-empty job without replacing that history.
      if (!recovery && row.evidenceJson !== canonicalJson(evidence)) fail("process_conflict");
      return row;
    }
    getDb()
      .update(taskDeviceProcesses)
      .set({
        state: "stopped",
        evidenceJson: canonicalJson(evidence),
        stoppedAt: new Date().toISOString(),
      })
      .where(eq(taskDeviceProcesses.id, id))
      .run();
    return getTaskDeviceProcess(id);
  });
}

/** Reserve BEFORE starting the native helper. These callbacks are internal
 * host capabilities, never REST/MCP/peer inputs. They cannot release a grant. */
export function createTaskDeviceProcessJournal(taskId: string) {
  const runId = currentTaskDeviceRunId();
  if (!runId) throw new DeviceExecutionError("run_scope_required");
  assertTaskDeviceExecution(taskId);
  const id = randomUUID();
  getDb()
    .insert(taskDeviceProcesses)
    .values({ id, taskId, runId, state: "reserved", createdAt: new Date().toISOString() })
    .run();
  function assertOrigin() {
    if (currentTaskDeviceRunId() !== runId) throw new DeviceExecutionError("run_fenced");
    return originalHost(id);
  }
  return {
    id,
    async onIdentity(value: ProcessHostIdentity): Promise<void> {
      const parsed = processHostIdentitySchema.safeParse(value);
      if (!parsed.success) return fail("process_invalid");
      getDb().transaction(() => {
        const row = assertOrigin();
        assertTaskDeviceExecution(taskId);
        const json = canonicalJson(parsed.data);
        if (row.identityJson === json && row.state === "identified") return;
        if (row.state !== "reserved") fail("process_conflict");
        if (
          getDb()
            .select()
            .from(taskDeviceProcesses)
            .where(eq(taskDeviceProcesses.supervisorId, parsed.data.id))
            .get()
        )
          fail("process_conflict");
        getDb()
          .update(taskDeviceProcesses)
          .set({ state: "identified", supervisorId: parsed.data.id, identityJson: json })
          .where(eq(taskDeviceProcesses.id, id))
          .run();
      });
    },
    async onPrepared(value: PreparedProcessIdentity): Promise<void> {
      const parsed = preparedProcessIdentitySchema.safeParse(value);
      if (!parsed.success) return fail("process_invalid");
      getDb().transaction(() => {
        const row = assertOrigin();
        assertTaskDeviceExecution(taskId);
        const json = canonicalJson(parsed.data);
        if (row.state === "prepared" && row.preparedJson === json) return;
        if (
          row.state !== "identified" ||
          row.identityJson !== canonicalJson(hostIdentity(parsed.data))
        )
          fail("process_conflict");
        getDb()
          .update(taskDeviceProcesses)
          .set({ state: "prepared", preparedJson: json })
          .where(eq(taskDeviceProcesses.id, id))
          .run();
      });
    },
    async onStopped(value: ProcessStopEvidence): Promise<void> {
      assertOrigin();
      // A fenced/aborted run still needs an accurate stop receipt. This writes
      // only the process journal, never results, locks, run state or authority.
      saveStop(id, value, false);
    },
  };
}

/** Recover only the identity loaded from this device's persisted run journal. */
export function getTaskDeviceProcessRecovery(id: string): ProcessHostIdentity {
  hostOnly();
  const row = originalHost(id);
  if (!row.identityJson) return fail("process_stop_unproven");
  return savedIdentity(row.identityJson);
}
export function recordTaskDeviceProcessRecovery(id: string, evidence: unknown) {
  hostOnly();
  return saveStop(id, evidence, true);
}

/** Successful JS return cannot retire a run while its native process remains
 * unresolved. Old runs without supervision receipts are NOT retroactive proof. */
export function assertTaskDeviceProcessesStopped(runId: string): void {
  if (
    getDb()
      .select({ id: taskDeviceProcesses.id })
      .from(taskDeviceProcesses)
      .where(and(eq(taskDeviceProcesses.runId, runId), ne(taskDeviceProcesses.state, "stopped")))
      .get()
  )
    fail("process_stop_unproven");
}
