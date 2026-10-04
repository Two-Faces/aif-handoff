import { Hono } from "hono";
import { z } from "zod";
import {
  getEnv,
  PeerError,
  SyncError,
  SnapshotTransferError,
  CodeSnapshotError,
  TaskCheckoutError,
} from "@aif/shared";
import { listSyncPeers, revokeSyncPeer, setSyncPeerAddress } from "@aif/data";
import { personalAdmin } from "../middleware/personalAdmin.js";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";
import { jsonValidator } from "../middleware/zodValidator.js";
import type { PeerSyncService } from "../services/peerSync.js";
import {
  peerInviteRequestSchema,
  peerPairRequestSchema,
  peerAddressRequestSchema,
  snapshotPublishRequestSchema,
  snapshotPullRequestSchema,
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
    if (
      error instanceof PeerError ||
      error instanceof SyncError ||
      error instanceof SnapshotTransferError ||
      error instanceof CodeSnapshotError ||
      error instanceof TaskCheckoutError
    )
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
  router.post("/snapshots/publish", jsonValidator(snapshotPublishRequestSchema), (c) => {
    const body = c.req.valid("json");
    return c.json(required().snapshots.publish(body.projectId, body.snapshotId), 201);
  });
  router.post("/:id/snapshots/pull", jsonValidator(snapshotPullRequestSchema), async (c) => {
    return c.json(
      await required().snapshots.pull({ ...c.req.valid("json"), peerId: c.req.param("id") }),
    );
  });
  router.get("/snapshots/transfers/:id", (c) =>
    c.json(required().snapshots.status(c.req.param("id"))),
  );
  router.get("/snapshots/projects/:projectId/transfers", (c) => {
    const projectId = z.uuid().parse(c.req.param("projectId"));
    return c.json(required().snapshots.list(projectId));
  });
  router.delete("/snapshots/transfers/:id", (c) => {
    required().snapshots.remove(c.req.param("id"));
    return c.json({ removed: true });
  });
  router.post("/snapshots/unpublish", jsonValidator(snapshotPublishRequestSchema), (c) => {
    const body = c.req.valid("json");
    required().snapshots.removeExport(body.projectId, body.snapshotId);
    return c.json({ removed: true });
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
