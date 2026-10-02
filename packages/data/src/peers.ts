import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import {
  canonicalJson,
  PeerError,
  peerAddressSchema,
  peerFingerprintSchema,
  peerIdentitySchema,
  syncInvitations,
  syncPeerProjects,
  syncPeers,
  syncPeerCursors,
  type CausalContext,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import { ensureProjectSyncState, isReplicatedProject } from "./syncMutations.js";
import { acknowledgeSyncOperations, listOutgoingSyncOperations } from "./syncJournal.js";

const projectIdsSchema = z.array(z.uuid()).min(1).max(50);
const tokenDigest = (token: string) => createHash("sha256").update(token).digest();
export function findSyncPeer(deviceId: string) {
  return getDb().select().from(syncPeers).where(eq(syncPeers.deviceId, deviceId)).get();
}
export function listSyncPeerProjects(peerId: string) {
  return getDb().select().from(syncPeerProjects).where(eq(syncPeerProjects.peerId, peerId)).all();
}
export function listSyncPeers() {
  return getDb()
    .select()
    .from(syncPeers)
    .all()
    .map((peer) => ({
      ...peer,
      projects: listSyncPeerProjects(peer.deviceId).map((scope) => ({
        ...scope,
        pendingOperations: listOutgoingSyncOperations(scope.projectId, peer.deviceId).length,
        pendingCountCapped: true,
      })),
    }));
}
export function requireSyncPeer(deviceId: string, fingerprint?: string) {
  const peer = findSyncPeer(deviceId);
  if (!peer) throw new PeerError("peer_not_paired");
  if (peer.revoked) throw new PeerError("peer_revoked");
  if (fingerprint !== undefined && peer.fingerprint !== fingerprint)
    throw new PeerError("peer_identity_mismatch");
  return peer;
}
export function requirePeerProject(peerId: string, projectId: string) {
  requireSyncPeer(peerId);
  const scope = getDb()
    .select()
    .from(syncPeerProjects)
    .where(and(eq(syncPeerProjects.peerId, peerId), eq(syncPeerProjects.projectId, projectId)))
    .get();
  if (!scope) throw new PeerError("peer_scope_denied");
  return scope;
}
export function updatePeerContact(peerId: string, errorCode: string | null = null) {
  getDb()
    .update(syncPeers)
    .set({
      lastErrorCode: errorCode,
      ...(errorCode ? {} : { lastContactAt: new Date().toISOString() }),
    })
    .where(eq(syncPeers.deviceId, peerId))
    .run();
}
export function revokeSyncPeer(peerId: string) {
  getDb().update(syncPeers).set({ revoked: true }).where(eq(syncPeers.deviceId, peerId)).run();
}
export function setSyncPeerAddress(peerId: string, address: string) {
  requireSyncPeer(peerId);
  getDb()
    .update(syncPeers)
    .set({ address: peerAddressSchema.parse(address) })
    .where(eq(syncPeers.deviceId, peerId))
    .run();
}
export function registerSyncPeer(input: {
  deviceId: string;
  name: string;
  fingerprint: string;
  address?: string;
  projectIds: string[];
}) {
  peerIdentitySchema.parse({ deviceId: input.deviceId, name: input.name });
  peerFingerprintSchema.parse(input.fingerprint);
  projectIdsSchema.parse(input.projectIds);
  if (input.deviceId === getLocalDevice().deviceId) throw new PeerError("peer_identity_mismatch");
  return getDb().transaction((tx) => {
    const existing = findSyncPeer(input.deviceId);
    const fingerprintOwner = tx
      .select()
      .from(syncPeers)
      .where(eq(syncPeers.fingerprint, input.fingerprint))
      .get();
    if (
      (existing && existing.fingerprint !== input.fingerprint) ||
      (fingerprintOwner && fingerprintOwner.deviceId !== input.deviceId)
    )
      throw new PeerError("peer_identity_mismatch");
    const address = input.address
      ? peerAddressSchema.parse(input.address)
      : (existing?.address ?? null);
    tx.insert(syncPeers)
      .values({
        deviceId: input.deviceId,
        name: input.name,
        fingerprint: input.fingerprint,
        address,
      })
      .onConflictDoUpdate({
        target: syncPeers.deviceId,
        set: { name: input.name, address, revoked: false },
      })
      .run();
    // Pairing is an explicit replacement of the allowlist; cursors for retained projects survive retries.
    for (const scope of listSyncPeerProjects(input.deviceId)) {
      if (!input.projectIds.includes(scope.projectId))
        tx.delete(syncPeerProjects)
          .where(
            and(
              eq(syncPeerProjects.peerId, input.deviceId),
              eq(syncPeerProjects.projectId, scope.projectId),
            ),
          )
          .run();
    }
    for (const projectId of new Set(input.projectIds))
      tx.insert(syncPeerProjects)
        .values({ peerId: input.deviceId, projectId })
        .onConflictDoNothing()
        .run();
  });
}
export function createPeerInvitation(
  expectedFingerprint: string,
  projectIds: string[],
  now = Date.now(),
) {
  peerFingerprintSchema.parse(expectedFingerprint);
  projectIdsSchema.parse(projectIds);
  for (const projectId of projectIds) {
    if (!isReplicatedProject(projectId)) throw new PeerError("peer_scope_denied");
    ensureProjectSyncState(projectId);
  }
  const token = randomBytes(32).toString("hex");
  const invitationId = randomUUID();
  const expiresAt = now + 5 * 60_000;
  getDb().transaction((tx) => {
    tx.delete(syncInvitations)
      .where(lt(syncInvitations.expiresAt, now - 60_000))
      .run();
    if (tx.select().from(syncInvitations).all().length >= 20)
      throw new PeerError("peer_quota_exceeded");
    tx.insert(syncInvitations)
      .values({
        id: invitationId,
        tokenDigest: tokenDigest(token).toString("hex"),
        expectedFingerprint,
        projectIdsJson: canonicalJson([...new Set(projectIds)].sort()),
        expiresAt,
      })
      .run();
  });
  return { invitationId, token, projectIds: [...new Set(projectIds)].sort(), expiresAt };
}
export function acceptPeerInvitation(
  input: {
    invitationId: string;
    token: string;
    deviceId: string;
    name: string;
    projectIds: string[];
  },
  fingerprint: string,
  now = Date.now(),
) {
  return getDb().transaction((tx) => {
    const invitation = tx
      .select()
      .from(syncInvitations)
      .where(eq(syncInvitations.id, input.invitationId))
      .get();
    if (
      !invitation ||
      invitation.expectedFingerprint !== fingerprint ||
      !timingSafeEqual(Buffer.from(invitation.tokenDigest, "hex"), tokenDigest(input.token))
    )
      throw new PeerError("pairing_invalid");
    if (invitation.expiresAt < now) throw new PeerError("pairing_expired");
    const allowed = projectIdsSchema.parse(JSON.parse(invitation.projectIdsJson));
    projectIdsSchema.parse(input.projectIds);
    if (input.projectIds.some((id) => !allowed.includes(id)))
      throw new PeerError("peer_scope_denied");
    const request = canonicalJson({
      deviceId: input.deviceId,
      name: input.name,
      projectIds: [...new Set(input.projectIds)].sort(),
    });
    if (
      invitation.acceptedDeviceId &&
      (invitation.acceptedDeviceId !== input.deviceId || invitation.acceptedRequestJson !== request)
    )
      throw new PeerError("pairing_used");
    // Lost reply retries are idempotent, but a consumed invitation never undoes revocation.
    if (invitation.acceptedDeviceId) requireSyncPeer(input.deviceId, fingerprint);
    else {
      registerSyncPeer({ ...input, fingerprint });
      tx.update(syncInvitations)
        .set({ acceptedDeviceId: input.deviceId, acceptedRequestJson: request })
        .where(eq(syncInvitations.id, input.invitationId))
        .run();
    }
    return input.projectIds;
  });
}
export function updatePeerProject(
  peerId: string,
  projectId: string,
  patch: {
    outgoingCheckpointId?: string | null;
    incomingCheckpointId?: string | null;
    bootstrapped?: boolean;
  },
) {
  requirePeerProject(peerId, projectId);
  getDb()
    .update(syncPeerProjects)
    .set(patch)
    .where(and(eq(syncPeerProjects.peerId, peerId), eq(syncPeerProjects.projectId, projectId)))
    .run();
}

/** Explicit repair restarts snapshots, retaining the board, journal and tombstones. */
export function resetPeerBootstrap(peerId: string, projectId: string) {
  updatePeerProject(peerId, projectId, {
    outgoingCheckpointId: null,
    incomingCheckpointId: null,
    bootstrapped: false,
  });
}
/** Only local-origin streams actually sent to this peer may advance its durable ACK. */
export function acknowledgePeerWatermarks(
  peerId: string,
  projectId: string,
  watermarks: CausalContext,
) {
  requirePeerProject(peerId, projectId);
  const own = getLocalDevice().deviceId;
  const sent = getDb()
    .select()
    .from(syncPeerCursors)
    .where(eq(syncPeerCursors.peerId, peerId))
    .all();
  const local = Object.fromEntries(
    Object.entries(watermarks).filter(([stream, seq]) => {
      if (!stream.startsWith(`${projectId}:`)) throw new PeerError("peer_scope_denied");
      if (stream.split(":")[1] !== own) return false;
      const cursor = sent.find((item) => item.streamKey === stream);
      // No unsent stream may be acknowledged; reordered old ACKs are harmless.
      if (!cursor) throw new PeerError("peer_request_invalid");
      return seq >= cursor.ackSequence;
    }),
  );
  acknowledgeSyncOperations(peerId, projectId, local);
}
