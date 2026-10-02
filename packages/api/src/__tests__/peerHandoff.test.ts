import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { localDevice, taskDeviceGrantHeads, resetEnvCache } from "@aif/shared";
import { eq } from "drizzle-orm";
import { generatePeerIdentity } from "../services/peerIdentity.js";
import { peerRequest, startPeerListener } from "../services/peerTransport.js";

const state = { db: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => state.db,
}));
const data = await import("@aif/data");
let server: Awaited<ReturnType<typeof startPeerListener>> | null = null;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  state.db.$client.close();
  state.db = createTestDb();
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  vi.unstubAllEnvs();
  resetEnvCache();
});
it("stages a grant over pinned TLS, exposes receipt only to its issuer and quarantines a fork without launching execution", async () => {
  const source = generatePeerIdentity(data.getLocalDevice().deviceId);
  const project = data.createProject({ name: "Peer handoff", rootPath: "" })!;
  const task = data.createTask({
    projectId: project.id,
    title: "Task",
    description: "",
    paused: true,
  })!;
  const parent = data.initializeTaskDeviceGrant(task.id);
  const target = generatePeerIdentity(crypto.randomUUID());
  state.db.update(localDevice).set({ deviceId: target.deviceId }).run();
  state.db
    .update(taskDeviceGrantHeads)
    .set({ state: "observed" })
    .where(eq(taskDeviceGrantHeads.taskId, task.id))
    .run();
  data.registerSyncPeer({
    deviceId: source.deviceId,
    name: "Source",
    fingerprint: source.fingerprint,
    projectIds: [project.id],
  });
  server = await startPeerListener({ identity: target, host: "127.0.0.1", port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const base = {
    identity: source,
    deviceId: target.deviceId,
    fingerprint: target.fingerprint,
    address: `https://127.0.0.1:${address.port}`,
  };
  const id = crypto.randomUUID();
  const offer = {
    version: 1 as const,
    id,
    grant: {
      version: 1 as const,
      projectId: project.id,
      taskId: task.id,
      ownerDeviceId: target.deviceId,
      issuerDeviceId: source.deviceId,
      executionEpoch: 1,
      predecessorId: parent.grantId,
      transferId: id,
      snapshotId: "b".repeat(64),
    },
  };
  const received = await peerRequest({ ...base, request: { kind: "handoffOffer", offer } });
  expect(received).toMatchObject({ id, state: "received" });
  expect(await peerRequest({ ...base, request: { kind: "handoffOffer", offer } })).toEqual(
    received,
  );
  expect(
    await peerRequest({ ...base, request: { kind: "handoffStatus", projectId: project.id, id } }),
  ).toEqual(received);
  expect(data.getTaskDeviceGrant(task.id)).toMatchObject({ state: "pending", activeRunId: null });
  expect(data.findTaskById(task.id)?.paused).toBe(true);
  expect(data.getTaskExecutionWorkspace(task.id)).toBeNull();
  await expect(
    peerRequest({
      ...base,
      request: { kind: "handoffStatus", projectId: crypto.randomUUID(), id },
    }),
  ).rejects.toMatchObject({ remoteCode: "peer_scope_denied" });
  await expect(
    peerRequest({
      ...base,
      request: {
        kind: "handoffOffer",
        offer: {
          ...offer,
          id: crypto.randomUUID(),
          grant: { ...offer.grant, transferId: crypto.randomUUID() },
        },
      },
    }),
  ).rejects.toMatchObject({ remoteCode: "peer_request_invalid" });
  const forkId = crypto.randomUUID();
  await expect(
    peerRequest({
      ...base,
      request: {
        kind: "handoffOffer",
        offer: {
          ...offer,
          id: forkId,
          grant: { ...offer.grant, transferId: forkId, snapshotId: "c".repeat(64) },
        },
      },
    }),
  ).rejects.toMatchObject({ remoteCode: "grant_conflict" });
  expect(data.getTaskDeviceGrant(task.id)?.state).toBe("conflicted");
  data.revokeSyncPeer(source.deviceId);
  await expect(
    peerRequest({ ...base, request: { kind: "handoffStatus", projectId: project.id, id } }),
  ).rejects.toMatchObject({ remoteCode: "peer_revoked" });
});
