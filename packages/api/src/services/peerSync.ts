import { z } from "zod";
import {
  causalContextSchema,
  checkpointManifestSchema,
  PeerError,
  peerInvitationSchema,
  type CausalContext,
  type PeerInvitation,
} from "@aif/shared";
import {
  acknowledgePeerCheckpoint,
  acknowledgePeerWatermarks,
  applyPeerDelta,
  createPeerInvitation,
  finishPeerCheckpoint,
  getLocalDevice,
  listSyncPeerProjects,
  listSyncPeers,
  offerPeerCheckpoint,
  peerDelta,
  preparePeerCheckpoint,
  readPeerCheckpoint,
  registerSyncPeer,
  requireSyncPeer,
  stagePeerCheckpoint,
  updatePeerContact,
  resetPeerBootstrap,
} from "@aif/data";
import { peerRequest, startPeerListener } from "./peerTransport.js";
import { type PeerTlsIdentity } from "./peerIdentity.js";
import { diagnosePeerError } from "./peerErrors.js";
import { createGitSnapshotTransferService } from "./gitSnapshotTransfer.js";
import {
  peerCheckpointChunkSchema,
  peerCheckpointProgressSchema,
  peerExchangeSchema,
  peerHelloSchema,
  type PeerRequest,
} from "./peerProtocol.js";

export function createPeerSyncService(
  identity: PeerTlsIdentity,
  onChange: () => void = () => {},
  transport = peerRequest,
) {
  const snapshots = createGitSnapshotTransferService(identity, transport);
  let listener: Awaited<ReturnType<typeof startPeerListener>> | null = null;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const running = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const retries = new Map<string, { failures: number; after: number }>();
  const resetting = new Set<string>();
  const localIdentity = () => {
    const { deviceId, name } = getLocalDevice();
    return { deviceId, name };
  };
  async function sync(peerId: string): Promise<void> {
    if (resetting.has(peerId)) return;
    const previous = running.get(peerId);
    if (previous) return previous;
    if (stopping) throw new PeerError("peer_not_enabled");
    const controller = new AbortController();
    controllers.set(peerId, controller);
    const run = (async () => {
      const peer = requireSyncPeer(peerId);
      if (!peer.address) throw new PeerError("peer_unavailable");
      const call = async (request: PeerRequest) => {
        requireSyncPeer(peerId, peer.fingerprint); // Revocation also stops an already-running transfer.
        return transport({
          address: peer.address!,
          fingerprint: peer.fingerprint,
          deviceId: peerId,
          identity,
          request,
          signal: controller.signal,
        });
      };
      const hello = peerHelloSchema.parse(await call({ kind: "hello" }));
      if (hello.identity.deviceId !== peerId) throw new PeerError("peer_identity_mismatch");
      for (const scope of listSyncPeerProjects(peerId)) {
        const projectId = scope.projectId;
        if (!hello.projectIds.includes(projectId)) continue;
        // Pull first: a newly paired receiver may not have the project yet.
        const incoming = checkpointManifestSchema
          .nullable()
          .parse(await call({ kind: "checkpointRequest", projectId }));
        if (incoming) {
          let progress = offerPeerCheckpoint(peerId, incoming);
          while (progress.next < incoming.recordCount) {
            const chunk = peerCheckpointChunkSchema.parse(
              await call({
                kind: "checkpointRead",
                projectId,
                checkpointId: incoming.checkpointId,
                from: progress.next,
              }),
            );
            if (
              chunk.checkpointId !== incoming.checkpointId ||
              chunk.from !== progress.next ||
              chunk.next <= progress.next ||
              chunk.next > incoming.recordCount
            )
              throw new PeerError("peer_checkpoint_mismatch");
            progress = stagePeerCheckpoint(peerId, projectId, incoming.checkpointId, chunk.records);
          }
          const watermarks = finishPeerCheckpoint(peerId, projectId, incoming.checkpointId);
          await call({
            kind: "checkpointAck",
            projectId,
            checkpointId: incoming.checkpointId,
            watermarks,
          });
          onChange();
        }
        const outgoing = preparePeerCheckpoint(peerId, projectId);
        if (outgoing) {
          let progress = peerCheckpointProgressSchema.parse(
            await call({ kind: "checkpointOffer", manifest: outgoing }),
          );
          if (progress.next > outgoing.recordCount) throw new PeerError("peer_checkpoint_mismatch");
          while (progress.next < outgoing.recordCount) {
            const chunk = readPeerCheckpoint(
              peerId,
              projectId,
              outgoing.checkpointId,
              progress.next,
            );
            const previous = progress.next;
            progress = peerCheckpointProgressSchema.parse(
              await call({
                kind: "checkpointStage",
                projectId,
                checkpointId: outgoing.checkpointId,
                entries: chunk.records,
              }),
            );
            if (progress.next <= previous || progress.next > chunk.next)
              throw new PeerError("peer_checkpoint_mismatch");
          }
          const watermarks = causalContextSchema.parse(
            await call({
              kind: "checkpointFinish",
              projectId,
              checkpointId: outgoing.checkpointId,
            }),
          );
          acknowledgePeerCheckpoint(peerId, projectId, outgoing.checkpointId, watermarks);
        }
        let ack: CausalContext = {};
        // Bound one scheduling turn; remaining journal rows are retried on the next tick.
        for (let batch = 0; batch < 100; batch++) {
          const operations = peerDelta(peerId, projectId);
          const result = peerExchangeSchema.parse(
            await call({ kind: "exchange", projectId, operations, ack }),
          );
          acknowledgePeerWatermarks(peerId, projectId, result.watermarks);
          const received = applyPeerDelta(peerId, projectId, result.operations);
          ack = received.watermarks;
          if (received.applied > 0) onChange();
          if (operations.length === 0 && result.operations.length === 0) break;
          if (result.operations.length > 0 && received.applied === 0 && operations.length === 0) {
            // Send durable ACK even for duplicates after a lost reply.
            const final = peerExchangeSchema.parse(
              await call({ kind: "exchange", projectId, operations: [], ack }),
            );
            if (final.operations.length) applyPeerDelta(peerId, projectId, final.operations);
            break;
          }
        }
      }
      updatePeerContact(peerId);
      retries.delete(peerId);
    })();
    running.set(peerId, run);
    try {
      await run;
    } catch (error) {
      const failures = (retries.get(peerId)?.failures ?? 0) + 1;
      retries.set(peerId, {
        failures,
        after: Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)),
      });
      const diagnosed = diagnosePeerError(error);
      try {
        updatePeerContact(peerId, diagnosed.code);
      } catch {
        /* Storage may also prevent diagnostic persistence. */
      }
      throw diagnosed;
    } finally {
      if (running.get(peerId) === run) running.delete(peerId);
      if (controllers.get(peerId) === controller) controllers.delete(peerId);
    }
  }
  function schedule() {
    if (stopping) return;
    timer = setTimeout(() => {
      for (const peer of listSyncPeers()) {
        if (!peer.revoked && peer.address && Date.now() >= (retries.get(peer.deviceId)?.after ?? 0))
          void sync(peer.deviceId).catch(() => {});
      }
      schedule();
    }, 3000);
    timer.unref();
  }
  return {
    snapshots,
    identity: () => ({ ...localIdentity(), fingerprint: identity.fingerprint }),
    async start(port: number, host?: string, reconnect = true) {
      if (listener) return listener;
      stopping = false;
      snapshots.start();
      listener = await startPeerListener({ identity, port, host, onChange });
      if (reconnect) schedule();
      return listener;
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      for (const controller of controllers.values()) controller.abort();
      await snapshots.stop();
      await Promise.allSettled([...running.values()]);
      if (listener) {
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener!.close(() => resolve()));
        listener = null;
      }
    },
    invitation(expectedFingerprint: string, projectIds: string[]): PeerInvitation {
      return {
        protocolVersion: 1,
        schemaVersion: 1,
        ...createPeerInvitation(expectedFingerprint, projectIds),
        deviceId: identity.deviceId,
        fingerprint: identity.fingerprint,
      };
    },
    async pair(address: string, invitation: PeerInvitation, projectIds: string[]) {
      peerInvitationSchema.parse(invitation);
      z.array(z.uuid()).min(1).max(50).parse(projectIds);
      if (projectIds.some((id) => !invitation.projectIds.includes(id)))
        throw new PeerError("peer_scope_denied");
      const result = peerHelloSchema.parse(
        await transport({
          address,
          fingerprint: invitation.fingerprint,
          deviceId: invitation.deviceId,
          identity,
          request: {
            kind: "pair",
            invitationId: invitation.invitationId,
            token: invitation.token,
            identity: localIdentity(),
            projectIds,
          },
        }),
      );
      if (
        result.identity.deviceId !== invitation.deviceId ||
        result.projectIds.length !== projectIds.length ||
        result.projectIds.some((id) => !projectIds.includes(id))
      )
        throw new PeerError("peer_identity_mismatch");
      registerSyncPeer({
        ...result.identity,
        fingerprint: invitation.fingerprint,
        address,
        projectIds,
      });
      return result.identity;
    },
    sync,
    async resync(peerId: string) {
      if (resetting.has(peerId)) return running.get(peerId);
      if (stopping) throw new PeerError("peer_not_enabled");
      resetting.add(peerId);
      const previous = running.get(peerId);
      controllers.get(peerId)?.abort();
      const controller = new AbortController();
      const prepare = (async () => {
        await previous?.catch(() => {});
        if (stopping) throw new PeerError("peer_not_enabled");
        controllers.set(peerId, controller);
        const peer = requireSyncPeer(peerId);
        if (!peer.address) throw new PeerError("peer_unavailable");
        for (const scope of listSyncPeerProjects(peerId)) {
          await transport({
            address: peer.address,
            fingerprint: peer.fingerprint,
            deviceId: peerId,
            identity,
            signal: controller.signal,
            request: { kind: "resync", projectId: scope.projectId },
          });
          resetPeerBootstrap(peerId, scope.projectId);
        }
      })();
      running.set(peerId, prepare);
      try {
        await prepare;
      } finally {
        resetting.delete(peerId);
        if (running.get(peerId) === prepare) running.delete(peerId);
        if (controllers.get(peerId) === controller) controllers.delete(peerId);
      }
      await sync(peerId);
    },
    cancel(peerId: string) {
      controllers.get(peerId)?.abort();
      snapshots.cancel(peerId);
    },
  };
}
export type PeerSyncService = ReturnType<typeof createPeerSyncService>;
