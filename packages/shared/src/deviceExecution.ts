import { z } from "zod";

const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Separate protocol from board workflow/assignees and coordinator leases. */
export const taskDeviceGrantSchema = z
  .object({
    version: z.literal(1),
    projectId: id,
    taskId: id,
    ownerDeviceId: id,
    executionEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    predecessorId: digest.nullable(),
    issuerDeviceId: id,
    transferId: id.nullable(),
    snapshotId: digest.nullable(),
  })
  .strict()
  .superRefine((grant, ctx) => {
    const genesis = grant.executionEpoch === 0;
    if (
      genesis
        ? grant.predecessorId !== null ||
          grant.transferId !== null ||
          grant.snapshotId !== null ||
          grant.issuerDeviceId !== grant.ownerDeviceId
        : grant.predecessorId === null ||
          grant.transferId === null ||
          grant.snapshotId === null ||
          grant.issuerDeviceId === grant.ownerDeviceId
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid execution grant chain." });
    }
  });
export type TaskDeviceGrant = z.infer<typeof taskDeviceGrantSchema>;

export class DeviceExecutionError extends Error {
  constructor(
    readonly code:
      | "grant_missing"
      | "grant_conflict"
      | "grant_not_owned"
      | "grant_not_ready"
      | "grant_invalid"
      | "release_not_proven"
      | "run_busy"
      | "run_fenced"
      | "run_scope_required"
      | "run_root_mismatch"
      | "taskless_execution_denied",
  ) {
    super(code);
    this.name = "DeviceExecutionError";
  }
}
