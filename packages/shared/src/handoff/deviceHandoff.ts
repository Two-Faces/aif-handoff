import { z } from "zod";
import { taskDeviceGrantSchema } from "../deviceExecution.js";
import {
  continuationNotesSchema,
  portableContextPathSchema,
  snapshotDigestSchema,
} from "./contracts.js";

export const taskDeviceHandoffRequestSchema = z
  .object({
    id: z.uuid(),
    taskId: z.uuid(),
    expectedGrantId: snapshotDigestSchema,
    targetDeviceId: z.uuid(),
    notes: continuationNotesSchema,
    portablePaths: z.array(portableContextPathSchema).max(512).optional(),
  })
  .strict();
export type TaskDeviceHandoffRequest = z.infer<typeof taskDeviceHandoffRequestSchema>;

/** Paths, stop attestations and local account IDs never cross the peer boundary. */
export const taskDeviceHandoffOfferSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    grant: taskDeviceGrantSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.grant.transferId !== value.id ||
      !value.grant.snapshotId ||
      !value.grant.predecessorId
    )
      ctx.addIssue({
        code: "custom",
        message: "A handoff offer requires its exact successor grant",
      });
  });
export type TaskDeviceHandoffOffer = z.infer<typeof taskDeviceHandoffOfferSchema>;
export const taskDeviceHandoffReceiptSchema = z
  .object({
    id: z.uuid(),
    grantId: snapshotDigestSchema,
    state: z.enum(["received", "accepted"]),
  })
  .strict();
export type TaskDeviceHandoffReceipt = z.infer<typeof taskDeviceHandoffReceiptSchema>;

export class DeviceHandoffError extends Error {
  constructor(
    readonly code:
      | "handoff_invalid"
      | "handoff_missing"
      | "handoff_conflict"
      | "handoff_not_owner"
      | "handoff_input_changed"
      | "handoff_stop_unproven"
      | "handoff_wrong_phase"
      | "handoff_snapshot_pending"
      | "handoff_manual_confirmation_required"
      | "handoff_irreversible",
  ) {
    super(code);
    this.name = "DeviceHandoffError";
  }
}
