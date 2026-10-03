import { z } from "zod";

const processId = z.number().int().positive().max(0xffffffff);
const birth = z.string().regex(/^[1-9][0-9]{0,19}$/);
const fields = {
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
export const processHostIdentitySchema = z.object(fields).strict().refine(boundJob);
export const preparedProcessIdentitySchema = z
  .object({ ...fields, pid: processId, birth })
  .strict()
  .refine(boundJob);
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
