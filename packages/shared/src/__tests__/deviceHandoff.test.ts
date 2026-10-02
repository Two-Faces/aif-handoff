import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  taskDeviceHandoffOfferSchema,
  taskDeviceHandoffRequestSchema,
  taskDeviceHandoffReceiptSchema,
} from "../handoff/deviceHandoff.js";

function offer() {
  const id = randomUUID();
  return {
    version: 1 as const,
    id,
    grant: {
      version: 1 as const,
      taskId: randomUUID(),
      projectId: randomUUID(),
      ownerDeviceId: randomUUID(),
      issuerDeviceId: randomUUID(),
      executionEpoch: 1,
      predecessorId: "a".repeat(64),
      transferId: id,
      snapshotId: "b".repeat(64),
    },
  };
}
describe("portable device handoff protocol", () => {
  it("binds an offer to the exact successor and accepts only bounded portable request data", () => {
    const value = offer();
    expect(taskDeviceHandoffOfferSchema.parse(value)).toEqual(value);
    expect(
      taskDeviceHandoffRequestSchema.safeParse({
        id: value.id,
        taskId: value.grant.taskId,
        expectedGrantId: value.grant.predecessorId,
        targetDeviceId: value.grant.ownerDeviceId,
        notes: { goal: "Continue", nextStep: "Inspect" },
        portablePaths: [".ai-factory/NOTES.md"],
      }).success,
    ).toBe(true);
    expect(
      taskDeviceHandoffReceiptSchema.safeParse({
        id: value.id,
        grantId: "c".repeat(64),
        state: "accepted",
      }).success,
    ).toBe(true);
  });
  it.each(["different_transfer", "genesis", "path", "stop_proof", "credentials"])(
    "rejects %s in peer offers",
    (kind) => {
      const value = offer();
      const altered =
        kind === "different_transfer"
          ? { ...value, id: randomUUID() }
          : kind === "genesis"
            ? {
                ...value,
                grant: {
                  ...value.grant,
                  executionEpoch: 0,
                  predecessorId: null,
                  transferId: null,
                  snapshotId: null,
                },
              }
            : { ...value, [kind]: "untrusted" };
      expect(taskDeviceHandoffOfferSchema.safeParse(altered).success).toBe(false);
    },
  );
  it("does not admit manual stop attestations or unsafe context paths through the request", () => {
    const value = offer();
    const request = {
      id: value.id,
      taskId: value.grant.taskId,
      expectedGrantId: value.grant.predecessorId,
      targetDeviceId: value.grant.ownerDeviceId,
      notes: { goal: "Continue", nextStep: "Inspect" },
    };
    expect(
      taskDeviceHandoffRequestSchema.safeParse({ ...request, forceStopped: true }).success,
    ).toBe(false);
    expect(
      taskDeviceHandoffRequestSchema.safeParse({ ...request, portablePaths: [".env"] }).success,
    ).toBe(false);
    expect(
      taskDeviceHandoffReceiptSchema.safeParse({
        id: value.id,
        grantId: "c".repeat(64),
        state: "owned",
      }).success,
    ).toBe(false);
  });
});
