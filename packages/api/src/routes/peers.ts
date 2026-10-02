import { Hono } from "hono";
import { z } from "zod";
import { getEnv, PeerError, SyncError } from "@aif/shared";
import { listSyncPeers, revokeSyncPeer, setSyncPeerAddress } from "@aif/data";
import { personalAdmin } from "../middleware/personalAdmin.js";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";
import { jsonValidator } from "../middleware/zodValidator.js";
import type { PeerSyncService } from "../services/peerSync.js";
import {
  peerInviteRequestSchema,
  peerPairRequestSchema,
  peerAddressRequestSchema,
} from "../schemas.js";

export function createPeersRouter(service: () => PeerSyncService | null) {
  const router = new Hono<ParticipantApiEnv>();
  router.use("*", personalAdmin);
  router.use("*", async (c, next) => {
    // Loopback binding alone does not prevent a foreign web page from sending a request.
    const origin = c.req.header("Origin");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname))
      return c.json({ code: "forbidden", error: "Loopback host required" }, 403);
    const allowed = new Set([
      ...getEnv().PARTICIPANT_ALLOWED_ORIGINS,
      process.env.CORS_ORIGIN || "http://localhost:5180",
      new URL(c.req.url).origin,
    ]);
    if (origin && !allowed.has(origin))
      return c.json({ code: "forbidden", error: "Origin is not allowed" }, 403);
    await next();
  });
  router.onError((error, c) => {
    if (error instanceof PeerError || error instanceof SyncError)
      return c.json({ code: error.code, error: error.message }, 409);
    if (error instanceof z.ZodError)
      return c.json({ code: "peer_request_invalid", error: "Invalid peer response" }, 400);
    throw error;
  });
  const required = () => {
    const value = service();
    if (!value) throw new PeerError("peer_not_enabled");
    return value;
  };
  router.get("/", (c) =>
    c.json({
      enabled: Boolean(service()),
      port: getEnv().AIF_PEER_PORT,
      device: service()?.identity() ?? null,
      peers: listSyncPeers(),
      executionReady: false,
    }),
  );
  router.post("/invitations", jsonValidator(peerInviteRequestSchema), (c) => {
    const body = c.req.valid("json");
    return c.json(required().invitation(body.expectedFingerprint, body.projectIds), 201);
  });
  router.post("/pair", jsonValidator(peerPairRequestSchema), async (c) => {
    const body = c.req.valid("json");
    return c.json(await required().pair(body.address, body.invitation, body.projectIds), 201);
  });
  router.post("/:id/sync", async (c) => {
    await required().sync(c.req.param("id"));
    return c.json({ synced: true });
  });
  router.post("/:id/resync", async (c) => {
    await required().resync(c.req.param("id"));
    return c.json({ resynced: true });
  });
  router.post("/:id/cancel", (c) => {
    required().cancel(c.req.param("id"));
    return c.json({ cancelled: true });
  });
  router.post("/:id/revoke", (c) => {
    revokeSyncPeer(c.req.param("id"));
    service()?.cancel(c.req.param("id"));
    return c.json({ revoked: true });
  });
  router.put("/:id/address", jsonValidator(peerAddressRequestSchema), (c) => {
    setSyncPeerAddress(c.req.param("id"), c.req.valid("json").address);
    return c.json({ updated: true });
  });
  return router;
}
