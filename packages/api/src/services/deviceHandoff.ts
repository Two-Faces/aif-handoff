import {
  getReleasedTaskHandoffOffer,
  getTaskDeviceHandoff,
  recordTaskHandoffReceipt,
  requireSyncPeer,
  requirePeerProject,
  quiesceTaskDeviceHandoff,
  listNativeTaskHandoffProcesses,
  confirmNativeTaskHandoffStop,
  checkpointTaskDeviceHandoff,
} from "@aif/data";
import { DeviceHandoffError, PeerError, taskDeviceHandoffReceiptSchema } from "@aif/shared";
import type { PeerTlsIdentity } from "./peerIdentity.js";
import type { peerRequest } from "./peerTransport.js";
import { recoverTaskDeviceProcess } from "./deviceProcessSupervisor.js";

/** Explicit internal source operation. Fence writes before native recovery;
 * recheck current journal/input after awaits. Release remains a separate action. */
export async function checkpointNativeTaskHandoff(id: string) {
  if (getTaskDeviceHandoff(id).phase === "checkpointed") return checkpointTaskDeviceHandoff(id);
  quiesceTaskDeviceHandoff(id);
  const processes = listNativeTaskHandoffProcesses(id);
  for (const process of processes) {
    if (process.state !== "stopped") await recoverTaskDeviceProcess(process.id);
  }
  const current = getTaskDeviceHandoff(id);
  confirmNativeTaskHandoffStop({ id, expectedRevision: current.revision });
  return checkpointTaskDeviceHandoff(id);
}

/** Host service only. Delivery is retryable after lost ACK; neither a peer
 * request nor a receipt accepts the task or starts a runtime on either device. */
export function createDeviceHandoffService(
  identity: PeerTlsIdentity,
  transport: typeof peerRequest,
) {
  async function exchange(id: string, statusOnly: boolean) {
    const offer = getReleasedTaskHandoffOffer(id);
    const row = getTaskDeviceHandoff(id);
    if (identity.deviceId !== row.sourceDeviceId) throw new DeviceHandoffError("handoff_not_owner");
    const peer = requireSyncPeer(row.targetDeviceId);
    requirePeerProject(peer.deviceId, row.projectId);
    if (!peer.address) throw new PeerError("peer_unavailable");
    const value = await transport({
      identity,
      address: peer.address,
      fingerprint: peer.fingerprint,
      deviceId: peer.deviceId,
      request: statusOnly
        ? { kind: "handoffStatus", projectId: row.projectId, id }
        : { kind: "handoffOffer", offer },
    });
    requireSyncPeer(peer.deviceId, peer.fingerprint);
    requirePeerProject(peer.deviceId, row.projectId);
    const receipt = taskDeviceHandoffReceiptSchema.safeParse(value);
    if (!receipt.success || receipt.data.id !== id) throw new DeviceHandoffError("handoff_invalid");
    return recordTaskHandoffReceipt(peer.deviceId, receipt.data);
  }
  return {
    deliver: (id: string) => exchange(id, false),
    refresh: (id: string) => exchange(id, true),
  };
}
