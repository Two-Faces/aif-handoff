import { z } from "zod";

const processId = z.number().int().positive().max(0xffffffff);
const birth = z.string().regex(/^[1-9][0-9]{0,19}$/);
const windowsFields = {
  version: z.literal(1),
  mechanism: z.literal("windows_job_v1"),
  id: z.uuidv4(),
  jobName: z.string().max(100),
  hostPid: processId,
  hostSessionId: z.number().int().nonnegative().max(0xffffffff),
  hostBirth: birth,
};
const boundJob = (value: { id: string; jobName: string }) =>
  value.jobName === `Local\\AifHandoff-${value.id}`;
const uint64 = z
  .string()
  .refine((v) => /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= 0xffffffffffffffffn);
const isUnsignedCount = (v: string) =>
  /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 0xffffffffffffffffn;
const unsignedCount = z.string().refine(isUnsignedCount);
export const processBootSessionIdSchema = z.uuid();
export const nativeMacProcessIdentitySchema = z
  .object({
    pid: processId.max(0x7fffffff),
    uid: z.number().int().nonnegative().max(0xffffffff),
    birth: uint64,
    uniqueId: uint64,
    pidVersion: z.number().int().nonnegative().max(0xffffffff),
    coalitionId: uint64,
    image: z
      .string()
      .startsWith("/")
      .max(4096)
      .refine((value) => !value.includes("\0")),
    stopped: z.boolean(),
  })
  .strict();
export const nativeMacUsageSchema = z
  .object({
    kind: z.literal("usage"),
    started: unsignedCount,
    exited: unsignedCount,
    active: unsignedCount,
  })
  .strict()
  .refine(
    (value) =>
      [value.started, value.exited, value.active].every(isUnsignedCount) &&
      BigInt(value.started) >= BigInt(value.exited) &&
      BigInt(value.started) - BigInt(value.exited) === BigInt(value.active),
  );
export type NativeMacProcessIdentity = z.infer<typeof nativeMacProcessIdentitySchema>;
export type NativeMacUsage = z.infer<typeof nativeMacUsageSchema>;
const macFields = {
  version: z.literal(1),
  mechanism: z.literal("macos_coalition_v1"),
  id: z.uuidv4(),
  serviceName: z.string().max(100),
  hostPid: processId,
  hostBirth: birth,
  hostUid: z.number().int().nonnegative().max(0xffffffff),
  hostUniqueId: uint64,
  hostPidVersion: z.number().int().nonnegative().max(0xffffffff),
  bootSessionId: processBootSessionIdSchema,
  coalitionId: uint64,
};
const boundService = (value: { id: string; serviceName: string }) =>
  value.serviceName === `com.aif.handoff.supervisor-${value.id}`;
export const windowsProcessHostIdentitySchema = z.object(windowsFields).strict().refine(boundJob);
export const windowsPreparedProcessIdentitySchema = z
  .object({ ...windowsFields, pid: processId, birth })
  .strict()
  .refine(boundJob);
export const macProcessHostIdentitySchema = z.object(macFields).strict().refine(boundService);
export const macPreparedProcessIdentitySchema = z
  .object({
    ...macFields,
    pid: processId,
    birth,
    uniqueId: uint64,
    pidVersion: z.number().int().nonnegative().max(0xffffffff),
  })
  .strict()
  .refine(boundService)
  .refine((value) => value.pid !== value.hostPid && value.uniqueId !== value.hostUniqueId);
export const processHostIdentitySchema = z.union([
  windowsProcessHostIdentitySchema,
  macProcessHostIdentitySchema,
]);
export const preparedProcessIdentitySchema = z.union([
  windowsPreparedProcessIdentitySchema,
  macPreparedProcessIdentitySchema,
]);
export const processStopEvidenceSchema = z
  .object({
    identity: z.union([processHostIdentitySchema, preparedProcessIdentitySchema]),
    activeProcesses: z.literal(0),
    reason: z.enum(["completed", "cancelled", "channel_closed", "recovered"]),
    exitCode: z.number().int().min(0).max(0xffffffff).nullable(),
    terminatedProcesses: z.number().int().nonnegative().max(0xffffffff).nullable(),
  })
  .strict()
  .refine((value) =>
    value.reason === "recovered"
      ? value.exitCode === null && value.terminatedProcesses === null
      : value.exitCode !== null && value.terminatedProcesses !== null,
  );
export type ProcessHostIdentity = z.infer<typeof processHostIdentitySchema>;
export type PreparedProcessIdentity = z.infer<typeof preparedProcessIdentitySchema>;
export type ProcessStopEvidence = z.infer<typeof processStopEvidenceSchema>;
export type WindowsProcessHostIdentity = z.infer<typeof windowsProcessHostIdentitySchema>;
export type WindowsPreparedProcessIdentity = z.infer<typeof windowsPreparedProcessIdentitySchema>;
export type MacProcessHostIdentity = z.infer<typeof macProcessHostIdentitySchema>;
export type MacPreparedProcessIdentity = z.infer<typeof macPreparedProcessIdentitySchema>;

/** Project an already validated native receipt onto its persisted host scope. */
export function processHostIdentity(
  value: ProcessHostIdentity | PreparedProcessIdentity,
): ProcessHostIdentity {
  if (!("pid" in value)) return value;
  if (value.mechanism === "macos_coalition_v1") {
    const { pid: _pid, birth: _birth, uniqueId: _unique, pidVersion: _version, ...host } = value;
    return host;
  }
  const { pid: _pid, birth: _birth, ...host } = value;
  return host;
}

export class ProcessJournalError extends Error {
  constructor(
    readonly code:
      | "process_missing"
      | "process_conflict"
      | "process_invalid"
      | "process_stop_unproven",
  ) {
    super(code);
    this.name = "ProcessJournalError";
  }
}
