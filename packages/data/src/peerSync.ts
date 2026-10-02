import { getDb } from "@aif/shared/server";
import {
  PeerError,
  type CausalContext,
  type CheckpointManifest,
  type SyncOperation,
} from "@aif/shared";
import { requirePeerProject, updatePeerProject, acknowledgePeerWatermarks } from "./peers.js";
import { ensureProjectSyncState } from "./syncMutations.js";
import { materializeSharedEntity } from "./syncDomain.js";
import {
  getSyncWatermarks,
  listOutgoingSyncOperations,
  markSyncOperationsSent,
  receiveSyncOperations,
} from "./syncJournal.js";
import {
  beginIncomingCheckpoint,
  createSyncCheckpoint,
  finishIncomingCheckpoint,
  getSyncCheckpointManifest,
  markSyncCheckpointSent,
  readSyncCheckpointChunk,
  stageIncomingCheckpoint,
} from "./syncCheckpoints.js";

export function preparePeerCheckpoint(peerId: string, projectId: string) {
  return getDb().transaction(() => {
    const scope = requirePeerProject(peerId, projectId);
    if (scope.bootstrapped) return null;
    ensureProjectSyncState(projectId);
    const manifest = scope.outgoingCheckpointId
      ? getSyncCheckpointManifest(scope.outgoingCheckpointId)
      : createSyncCheckpoint(projectId);
    updatePeerProject(peerId, projectId, { outgoingCheckpointId: manifest.checkpointId });
    markSyncCheckpointSent(peerId, manifest);
    return manifest;
  });
}
export function readPeerCheckpoint(
  peerId: string,
  projectId: string,
  checkpointId: string,
  from: number,
) {
  const scope = requirePeerProject(peerId, projectId);
  if (scope.outgoingCheckpointId !== checkpointId) throw new PeerError("peer_checkpoint_mismatch");
  return readSyncCheckpointChunk(checkpointId, from);
}
export function offerPeerCheckpoint(peerId: string, manifest: CheckpointManifest) {
  return getDb().transaction(() => {
    const scope = requirePeerProject(peerId, manifest.projectId);
    if (scope.incomingCheckpointId && scope.incomingCheckpointId !== manifest.checkpointId)
      throw new PeerError("peer_checkpoint_mismatch");
    const result = beginIncomingCheckpoint(peerId, [manifest.projectId], manifest);
    updatePeerProject(peerId, manifest.projectId, { incomingCheckpointId: manifest.checkpointId });
    return result;
  });
}
function requireIncoming(peerId: string, projectId: string, checkpointId: string) {
  const scope = requirePeerProject(peerId, projectId);
  if (scope.incomingCheckpointId !== checkpointId) throw new PeerError("peer_checkpoint_mismatch");
}
export function stagePeerCheckpoint(
  peerId: string,
  projectId: string,
  checkpointId: string,
  entries: readonly { ordinal: number; record: unknown }[],
) {
  requireIncoming(peerId, projectId, checkpointId);
  return stageIncomingCheckpoint(peerId, checkpointId, entries);
}
export function finishPeerCheckpoint(peerId: string, projectId: string, checkpointId: string) {
  requireIncoming(peerId, projectId, checkpointId);
  return finishIncomingCheckpoint(peerId, checkpointId, materializeSharedEntity);
}
export function acknowledgePeerCheckpoint(
  peerId: string,
  projectId: string,
  checkpointId: string,
  watermarks: CausalContext,
) {
  getDb().transaction(() => {
    const scope = requirePeerProject(peerId, projectId);
    if (scope.outgoingCheckpointId !== checkpointId)
      throw new PeerError("peer_checkpoint_mismatch");
    const manifest = getSyncCheckpointManifest(checkpointId);
    if (
      Object.entries(manifest.watermarks).some(([stream, seq]) => (watermarks[stream] ?? 0) < seq)
    )
      throw new PeerError("peer_checkpoint_mismatch");
    acknowledgePeerWatermarks(peerId, projectId, watermarks);
    updatePeerProject(peerId, projectId, { bootstrapped: true });
  });
}
export function peerDelta(peerId: string, projectId: string): SyncOperation[] {
  requirePeerProject(peerId, projectId);
  const batch: SyncOperation[] = [];
  let bytes = 0;
  for (const op of listOutgoingSyncOperations(projectId, peerId)) {
    const size = Buffer.byteLength(JSON.stringify(op));
    if (bytes + size > 3_500_000) break;
    batch.push(op);
    bytes += size;
  }
  markSyncOperationsSent(peerId, batch);
  return batch;
}
export function applyPeerDelta(peerId: string, projectId: string, operations: SyncOperation[]) {
  requirePeerProject(peerId, projectId);
  const result = receiveSyncOperations(
    { peerDeviceId: peerId, allowedProjectIds: [projectId], operations },
    materializeSharedEntity,
  );
  return { applied: result.applied, watermarks: getSyncWatermarks(projectId) };
}
