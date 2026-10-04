import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { canonicalJson, DeviceHandoffError, PeerError, DeviceExecutionError } from "@aif/shared";
import { generatePeerIdentity } from "../services/peerIdentity.js";
import { diagnosePeerError } from "../services/peerErrors.js";
import { peerRequestSchema } from "../services/peerProtocol.js";
import type { peerRequest } from "../services/peerTransport.js";

const mocks = vi.hoisted(() => ({
  offer: vi.fn(),
  row: vi.fn(),
  peer: vi.fn(),
  scope: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock("@aif/data", () => ({
  getReleasedTaskHandoffOffer: mocks.offer,
  getTaskDeviceHandoff: mocks.row,
  requireSyncPeer: mocks.peer,
  requirePeerProject: mocks.scope,
  recordTaskHandoffReceipt: mocks.receipt,
}));
const { createDeviceHandoffService } = await import("../services/deviceHandoff.js");
const identity = generatePeerIdentity(randomUUID());
let offered: {
  version: 1;
  id: string;
  grant: {
    version: 1;
    taskId: string;
    projectId: string;
    ownerDeviceId: string;
    issuerDeviceId: string;
    executionEpoch: number;
    predecessorId: string;
    transferId: string;
    snapshotId: string;
  };
};
let grantId: string;
beforeEach(() => {
  vi.resetAllMocks();
  const id = randomUUID();
  offered = {
    version: 1,
    id,
    grant: {
      version: 1,
      taskId: randomUUID(),
      projectId: randomUUID(),
      ownerDeviceId: randomUUID(),
      issuerDeviceId: identity.deviceId,
      executionEpoch: 1,
      predecessorId: "a".repeat(64),
      transferId: id,
      snapshotId: "b".repeat(64),
    },
  };
  grantId = createHash("sha256").update(canonicalJson(offered.grant)).digest("hex");
  mocks.offer.mockReturnValue(offered);
  mocks.row.mockReturnValue({
    id,
    projectId: offered.grant.projectId,
    sourceDeviceId: identity.deviceId,
    targetDeviceId: offered.grant.ownerDeviceId,
    phase: "released",
  });
  mocks.peer.mockReturnValue({
    deviceId: offered.grant.ownerDeviceId,
    address: "https://127.0.0.1:31001",
    fingerprint: "c".repeat(64),
  });
  mocks.receipt.mockImplementation((_peer, receipt) => {
    if (receipt.grantId !== grantId) throw new DeviceHandoffError("handoff_conflict");
    return { ...mocks.row(), phase: receipt.state };
  });
});
describe("explicit handoff delivery service", () => {
  it("sends the immutable grant through the pinned peer and records receipt without acceptance or execution", async () => {
    const transport = vi
      .fn<typeof peerRequest>()
      .mockResolvedValue({ id: offered.id, grantId, state: "received" });
    const service = createDeviceHandoffService(identity, transport);
    expect((await service.deliver(offered.id)).phase).toBe("received");
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        deviceId: offered.grant.ownerDeviceId,
        fingerprint: "c".repeat(64),
        request: { kind: "handoffOffer", offer: offered },
      }),
    );
    expect(Object.keys(service).sort()).toEqual(["deliver", "refresh"]);
    expect(mocks.scope).toHaveBeenCalledTimes(2);
    transport.mockResolvedValue({ id: offered.id, grantId, state: "accepted" });
    expect((await service.refresh(offered.id)).phase).toBe("accepted");
    expect(transport.mock.lastCall?.[0].request).toEqual({
      kind: "handoffStatus",
      projectId: offered.grant.projectId,
      id: offered.id,
    });
  });
  it("retries the same offer after a lost ACK without restoring source authority", async () => {
    const transport = vi
      .fn<typeof peerRequest>()
      .mockRejectedValueOnce(new PeerError("peer_unavailable"))
      .mockResolvedValue({ id: offered.id, grantId, state: "received" });
    const service = createDeviceHandoffService(identity, transport);
    await expect(service.deliver(offered.id)).rejects.toMatchObject({ code: "peer_unavailable" });
    expect(mocks.receipt).not.toHaveBeenCalled();
    await service.deliver(offered.id);
    expect(transport.mock.calls[0][0].request).toEqual(transport.mock.calls[1][0].request);
    expect(mocks.row().phase).toBe("released");
  });
  it("rechecks revocation after the network wait", async () => {
    const transport = vi.fn<typeof peerRequest>().mockImplementation(async () => {
      mocks.scope.mockImplementation(() => {
        throw new PeerError("peer_revoked");
      });
      return { id: offered.id, grantId, state: "accepted" };
    });
    await expect(
      createDeviceHandoffService(identity, transport).deliver(offered.id),
    ).rejects.toMatchObject({ code: "peer_revoked" });
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it.each(["wrong_id", "wrong_grant", "invalid"])("rejects a %s response", async (kind) => {
    const transport = vi.fn<typeof peerRequest>().mockResolvedValue(
      kind === "invalid"
        ? {}
        : {
            id: kind === "wrong_id" ? randomUUID() : offered.id,
            grantId: kind === "wrong_grant" ? "d".repeat(64) : grantId,
            state: "accepted",
          },
    );
    await expect(
      createDeviceHandoffService(identity, transport).deliver(offered.id),
    ).rejects.toBeInstanceOf(DeviceHandoffError);
  });
  it("rejects a mismatched local identity or missing peer address before sending", async () => {
    const transport = vi.fn<typeof peerRequest>();
    mocks.row.mockReturnValueOnce({ ...mocks.row(), sourceDeviceId: randomUUID() });
    await expect(
      createDeviceHandoffService(identity, transport).deliver(offered.id),
    ).rejects.toMatchObject({ code: "handoff_not_owner" });
    mocks.peer.mockReturnValue({ ...mocks.peer(), address: null });
    await expect(
      createDeviceHandoffService(identity, transport).deliver(offered.id),
    ).rejects.toMatchObject({ code: "peer_unavailable" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("preserves structured errors and disallows stop commands, paths and manual confirmations on the peer wire", () => {
    for (const error of [
      new DeviceHandoffError("handoff_stop_unproven"),
      new DeviceExecutionError("grant_conflict"),
    ])
      expect(diagnosePeerError(error)).toBe(error);
    expect(peerRequestSchema.safeParse({ kind: "handoffOffer", offer: offered }).success).toBe(
      true,
    );
    expect(
      peerRequestSchema.safeParse({
        kind: "handoffOffer",
        offer: { ...offered, stopped: true, path: "/tmp/target" },
      }).success,
    ).toBe(false);
    expect(
      peerRequestSchema.safeParse({
        kind: "handoffStop",
        projectId: offered.grant.projectId,
        id: offered.id,
      }).success,
    ).toBe(false);
  });
});
