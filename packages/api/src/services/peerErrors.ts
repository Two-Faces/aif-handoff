import {
  PeerError,
  SyncError,
  SnapshotTransferError,
  DeviceHandoffError,
  DeviceExecutionError,
} from "@aif/shared";

/** Preserve structured storage failures without exposing SQL, paths or payloads. */
export function diagnosePeerError(
  error: unknown,
): PeerError | SyncError | SnapshotTransferError | DeviceHandoffError | DeviceExecutionError {
  if (
    error instanceof PeerError ||
    error instanceof SyncError ||
    error instanceof SnapshotTransferError ||
    error instanceof DeviceHandoffError ||
    error instanceof DeviceExecutionError
  )
    return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "SQLITE_FULL" || code === "ENOSPC") return new PeerError("peer_storage_full");
  if (
    typeof code === "string" &&
    (code.startsWith("SQLITE_IOERR") ||
      ["SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_CANTOPEN"].includes(code))
  )
    return new PeerError("peer_storage_unavailable");
  return new PeerError("peer_request_invalid");
}
