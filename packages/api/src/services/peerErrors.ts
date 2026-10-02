import { PeerError, SyncError } from "@aif/shared";

/** Preserve structured storage failures without exposing SQL, paths or payloads. */
export function diagnosePeerError(error: unknown): PeerError | SyncError {
  if (error instanceof PeerError || error instanceof SyncError) return error;
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
