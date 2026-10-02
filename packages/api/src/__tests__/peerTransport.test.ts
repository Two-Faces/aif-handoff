import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { X509Certificate } from "node:crypto";
import { createTestDb } from "@aif/shared/server";
import { createServer, request as httpsRequest } from "node:https";
import { generatePeerIdentity } from "../services/peerIdentity.js";
import { peerRequest, startPeerListener } from "../services/peerTransport.js";
import { peerHelloSchema } from "../services/peerProtocol.js";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => testDb.current,
}));
const data = await import("@aif/data");
const servers: Awaited<ReturnType<typeof startPeerListener>>[] = [];
beforeEach(() => {
  testDb.current.$client.close();
  testDb.current = createTestDb();
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
describe("pinned TLS peer listener", () => {
  it("pairs over mutual TLS, rejects unknown/revoked identities and enforces project scopes", async () => {
    const identity = generatePeerIdentity(data.getLocalDevice().deviceId);
    expect(
      new X509Certificate(identity.cert).verify(new X509Certificate(identity.cert).publicKey),
    ).toBe(true);
    const client = generatePeerIdentity(crypto.randomUUID());
    const server = await startPeerListener({ identity, port: 0, host: "127.0.0.1" });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const base = {
      identity: client,
      deviceId: identity.deviceId,
      fingerprint: identity.fingerprint,
      address: `https://127.0.0.1:${address.port}`,
    };
    const incompatible = await new Promise<unknown>((resolve, reject) => {
      const request = httpsRequest(
        `${base.address}/sync`,
        {
          method: "POST",
          key: client.key,
          cert: client.cert,
          rejectUnauthorized: false,
          minVersion: "TLSv1.3",
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += String(chunk);
          });
          response.on("end", () => {
            try {
              resolve(JSON.parse(text));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      request.end(
        JSON.stringify({
          protocolVersion: 0,
          schemaVersion: 1,
          deviceId: client.deviceId,
          request: { kind: "hello" },
        }),
      );
    });
    expect(incompatible).toMatchObject({ error: "peer_incompatible" });
    await expect(peerRequest({ ...base, request: { kind: "hello" } })).rejects.toMatchObject({
      remoteCode: "peer_not_paired",
    });
    const project = data.createProject({ name: "Board", rootPath: "", personalMode: true })!;
    const invitation = data.createPeerInvitation(client.fingerprint, [project.id]);
    const pair = {
      kind: "pair" as const,
      invitationId: invitation.invitationId,
      token: invitation.token,
      identity: { deviceId: client.deviceId, name: "Client" },
      projectIds: [project.id],
    };
    expect(peerHelloSchema.parse(await peerRequest({ ...base, request: pair })).projectIds).toEqual(
      [project.id],
    );
    expect(peerHelloSchema.parse(await peerRequest({ ...base, request: pair })).projectIds).toEqual(
      [project.id],
    );
    await expect(
      peerRequest({
        ...base,
        request: { kind: "checkpointRequest", projectId: crypto.randomUUID() },
      }),
    ).rejects.toMatchObject({ remoteCode: "peer_scope_denied" });
    data.revokeSyncPeer(client.deviceId);
    await expect(peerRequest({ ...base, request: { kind: "hello" } })).rejects.toMatchObject({
      remoteCode: "peer_revoked",
    });
    await expect(peerRequest({ ...base, request: pair })).rejects.toMatchObject({
      remoteCode: "peer_revoked",
    });
  });
  it("sends no HTTP request or pairing token before verifying the server fingerprint", async () => {
    const identity = generatePeerIdentity(data.getLocalDevice().deviceId);
    const received = vi.fn();
    const server = createServer({ key: identity.key, cert: identity.cert }, received);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    await expect(
      peerRequest({
        address: `https://127.0.0.1:${address.port}`,
        fingerprint: "0".repeat(64),
        deviceId: identity.deviceId,
        identity: generatePeerIdentity(crypto.randomUUID()),
        request: { kind: "hello" },
      }),
    ).rejects.toMatchObject({ code: "peer_identity_mismatch" });
    expect(received).not.toHaveBeenCalled();
  });
  it("does not accept an expired invitation or a different client certificate", () => {
    const project = data.createProject({ name: "Board", rootPath: "", personalMode: true })!;
    const client = generatePeerIdentity(crypto.randomUUID());
    const invitation = data.createPeerInvitation(client.fingerprint, [project.id], 100);
    const input = { ...invitation, deviceId: client.deviceId, name: "Client" };
    expect(() => data.acceptPeerInvitation(input, client.fingerprint, 400_000)).toThrow(
      expect.objectContaining({ code: "pairing_expired" }),
    );
    expect(() => data.acceptPeerInvitation(input, "0".repeat(64), 101)).toThrow(
      expect.objectContaining({ code: "pairing_invalid" }),
    );
    expect(data.listSyncPeers()).toEqual([]);
  });
});
