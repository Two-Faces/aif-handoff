import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { taskDeviceGrantSchema } from "../deviceExecution.js";
import { sharedTaskFields } from "../sync/contracts.js";

const owner = randomUUID();
const genesis = {
  version: 1,
  projectId: randomUUID(),
  taskId: randomUUID(),
  ownerDeviceId: owner,
  issuerDeviceId: owner,
  executionEpoch: 0,
  predecessorId: null,
  transferId: null,
  snapshotId: null,
};
describe("device execution protocol", () => {
  it("validates separate genesis and snapshot-bound successor contracts", () => {
    expect(taskDeviceGrantSchema.parse(genesis)).toEqual(genesis);
    expect(
      taskDeviceGrantSchema.parse({
        ...genesis,
        executionEpoch: 1,
        ownerDeviceId: randomUUID(),
        predecessorId: "a".repeat(64),
        transferId: randomUUID(),
        snapshotId: "b".repeat(64),
      }).executionEpoch,
    ).toBe(1);
  });
  it.each([
    { executionEpoch: -1 },
    { executionEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { issuerDeviceId: randomUUID() },
    { transferId: randomUUID() },
    { executionEpoch: 1 },
    { lockedUntil: "tomorrow" },
    { runId: randomUUID() },
  ])("rejects malformed genesis or injected authority (%#)", (patch) => {
    expect(taskDeviceGrantSchema.safeParse({ ...genesis, ...patch }).success).toBe(false);
  });
  it("does not admit device grants in the replicated task workflow", () => {
    expect(
      sharedTaskFields.partial().safeParse({ ownerDeviceId: owner, executionEpoch: 1 }).success,
    ).toBe(false);
  });
});
