import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "@aif/shared/server";
import { resetEnvCache } from "@aif/shared";
import { createPeersRouter } from "../routes/peers.js";
import { createPeerSyncService } from "../services/peerSync.js";
import { generatePeerIdentity } from "../services/peerIdentity.js";

const state = { db: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => state.db,
}));
const data = await import("@aif/data");
beforeEach(() => {
  state.db.$client.close();
  state.db = createTestDb();
  vi.stubEnv("PARTICIPANTS_MODE_ENABLED", "false");
  resetEnvCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
});
const send = (app: Hono, path: string, body: unknown = {}, method = "POST") =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
describe("local peer administration", () => {
  it("shows disabled state and refuses start operations or foreign browser origins", async () => {
    const app = new Hono().route(
      "/peers",
      createPeersRouter(() => null),
    );
    expect(await (await app.request("/peers")).json()).toMatchObject({
      enabled: false,
      executionReady: false,
    });
    expect((await send(app, "/peers/a/sync")).status).toBe(409);
    expect(
      (await app.request("/peers", { headers: { Origin: "https://foreign.invalid" } })).status,
    ).toBe(403);
    expect((await app.request("http://rebound.invalid/peers")).status).toBe(403);
  });
  it("validates invitation scope and exposes pairing, address, sync, cancel and revoke", async () => {
    const project = data.createProject({ name: "Board", rootPath: "", personalMode: true })!;
    const identity = generatePeerIdentity(data.getLocalDevice().deviceId);
    const service = createPeerSyncService(identity);
    const app = new Hono().route(
      "/peers",
      createPeersRouter(() => service),
    );
    expect(
      (await send(app, "/peers/invitations", { expectedFingerprint: "bad", projectIds: [] }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(app, "/peers/invitations", {
          expectedFingerprint: "a".repeat(64),
          projectIds: [crypto.randomUUID()],
        })
      ).status,
    ).toBe(409);
    const response = await send(app, "/peers/invitations", {
      expectedFingerprint: "a".repeat(64),
      projectIds: [project.id],
    });
    expect(response.status).toBe(201);
    const invitation = await response.json();
    const peerId = crypto.randomUUID();
    data.registerSyncPeer({
      deviceId: peerId,
      name: "Peer",
      fingerprint: "a".repeat(64),
      projectIds: [project.id],
    });
    vi.spyOn(service, "pair").mockResolvedValue({ deviceId: peerId, name: "Peer" });
    vi.spyOn(service, "sync").mockResolvedValue();
    expect(
      (
        await send(app, "/peers/pair", {
          address: "https://127.0.0.1:3011",
          invitation,
          projectIds: [project.id],
        })
      ).status,
    ).toBe(201);
    expect(
      (await send(app, `/peers/${peerId}/address`, { address: "https://127.0.0.1:3011" }, "PUT"))
        .status,
    ).toBe(200);
    expect((await send(app, `/peers/${peerId}/sync`)).status).toBe(200);
    expect((await send(app, `/peers/${peerId}/cancel`)).status).toBe(200);
    expect((await send(app, `/peers/${peerId}/revoke`)).status).toBe(200);
    expect(data.findSyncPeer(peerId)?.revoked).toBe(true);
    await service.stop();
  });
  it("requires the local administrator when participants mode is enabled", async () => {
    vi.stubEnv("PARTICIPANTS_MODE_ENABLED", "true");
    resetEnvCache();
    const app = new Hono().route(
      "/peers",
      createPeersRouter(() => null),
    );
    expect((await app.request("/peers")).status).toBe(403);
  });
});
