import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { PeerError } from "@aif/shared";
import { generatePeerIdentity } from "../services/peerIdentity.js";
import { createPeerSyncService } from "../services/peerSync.js";
import { dispatchPeerRequest, type peerRequest } from "../services/peerTransport.js";

const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const data = await import("@aif/data");
let left: ReturnType<typeof createTestDb>;
let right: ReturnType<typeof createTestDb>;
beforeEach(() => {
  db.current.$client.close();
  left = createTestDb();
  right = createTestDb();
  db.current = left;
});
afterEach(() => {
  left.$client.close();
  right.$client.close();
  db.current = createTestDb();
});
async function fixture() {
  const leftIdentity = generatePeerIdentity(data.getLocalDevice().deviceId);
  const project = data.createProject({ name: "Board", rootPath: "", personalMode: true })!;
  const tasks = Array.from(
    { length: 6 },
    (_, index) =>
      data.createTask({ projectId: project.id, title: `Task ${index}`, description: "Seed" })!,
  );
  db.current = right;
  const rightIdentity = generatePeerIdentity(data.getLocalDevice().deviceId);
  db.current = left;
  const invitation = {
    ...data.createPeerInvitation(rightIdentity.fingerprint, [project.id]),
    deviceId: leftIdentity.deviceId,
    fingerprint: leftIdentity.fingerprint,
    protocolVersion: 1 as const,
    schemaVersion: 1 as const,
  };
  let dropped: string | null = null;
  let blockedKind: string | null = null;
  let blockedReady: (() => void) | null = null;
  let tamper: ((result: unknown) => unknown) | null = null;
  const dispatch: typeof peerRequest = async (input) => {
    if (input.request.kind === blockedKind) {
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new PeerError("peer_unavailable")), {
          once: true,
        });
        blockedReady?.();
      });
    }
    const previous = db.current;
    db.current = left;
    try {
      const result = structuredClone(
        dispatchPeerRequest(input.identity.deviceId, input.request, input.identity.fingerprint),
      );
      if (input.request.kind === dropped) {
        dropped = null;
        throw new PeerError("peer_unavailable");
      }
      return tamper ? tamper(result) : result;
    } finally {
      db.current = previous;
    }
  };
  db.current = right;
  const changed = vi.fn();
  const service = createPeerSyncService(rightIdentity, changed, dispatch);
  await service.pair("https://fixture.invalid:3010", invitation, [project.id]);
  return {
    service,
    changed,
    project,
    tasks,
    peerId: leftIdentity.deviceId,
    drop: (kind: string) => {
      dropped = kind;
    },
    block: (kind: string) =>
      new Promise<void>((resolve) => {
        blockedKind = kind;
        blockedReady = resolve;
      }),
    tamper: (value: typeof tamper) => {
      tamper = value;
    },
  };
}
describe("resumable peer synchronization", () => {
  it("cancels a pending repair request during shutdown without resetting the local snapshot", async () => {
    const f = await fixture();
    await f.service.sync(f.peerId);
    const started = f.block("resync");
    const pending = f.service.resync(f.peerId);
    const rejected = expect(pending).rejects.toMatchObject({ code: "peer_unavailable" });
    await started;
    await f.service.stop();
    await rejected;
    expect(data.listSyncPeerProjects(f.peerId)[0]?.bootstrapped).toBe(true);
  });
  it("streams multi-chunk bootstrap, retries durable ACK loss, and performs bidirectional delta", async () => {
    const f = await fixture();
    f.drop("checkpointAck");
    await expect(f.service.sync(f.peerId)).rejects.toMatchObject({ code: "peer_unavailable" });
    expect(data.findSyncPeer(f.peerId)?.lastErrorCode).toBe("peer_unavailable");
    expect(data.listTasks(f.project.id)).toHaveLength(6);
    await f.service.sync(f.peerId);
    expect(data.listSyncPeerProjects(f.peerId)[0]?.bootstrapped).toBe(true);
    data.updateTask(f.tasks[0]!.id, { title: "Local edit" });
    db.current = left;
    data.updateTask(f.tasks[0]!.id, { description: "Remote edit" });
    db.current = right;
    f.drop("exchange");
    await expect(f.service.sync(f.peerId)).rejects.toMatchObject({ code: "peer_unavailable" });
    await f.service.sync(f.peerId);
    expect(data.findTaskById(f.tasks[0]!.id)).toMatchObject({
      title: "Local edit",
      description: "Remote edit",
    });
    expect(data.findSyncPeer(f.peerId)?.lastErrorCode).toBeNull();
    expect(f.changed).toHaveBeenCalled();
    await f.service.resync(f.peerId);
    expect(data.listTasks(f.project.id)).toHaveLength(6);
    await f.service.stop();
    await expect(f.service.sync(f.peerId)).rejects.toMatchObject({ code: "peer_not_enabled" });
  });
  it("deduplicates simultaneous sync requests and refuses mismatched hello identities", async () => {
    const f = await fixture();
    await Promise.all([f.service.sync(f.peerId), f.service.sync(f.peerId)]);
    f.tamper((result) =>
      result && typeof result === "object" && "identity" in result
        ? { ...result, identity: { deviceId: crypto.randomUUID(), name: "Wrong" } }
        : result,
    );
    await expect(f.service.sync(f.peerId)).rejects.toMatchObject({
      code: "peer_identity_mismatch",
    });
    f.tamper(null);
    data.revokeSyncPeer(f.peerId);
    await expect(f.service.sync(f.peerId)).rejects.toMatchObject({ code: "peer_revoked" });
    await f.service.stop();
  });
  it("rejects a checkpoint chunk that makes no progress and supports listener shutdown", async () => {
    const f = await fixture();
    f.tamper((result) =>
      result && typeof result === "object" && "from" in result
        ? { ...result, next: result.from }
        : result,
    );
    await expect(f.service.sync(f.peerId)).rejects.toMatchObject({
      code: "peer_checkpoint_mismatch",
    });
    f.tamper(null);
    const listener = await f.service.start(0, "127.0.0.1", false);
    expect(await f.service.start(0)).toBe(listener);
    await f.service.sync(f.peerId);
    await f.service.stop();
    expect(listener.listening).toBe(false);
  });
});
