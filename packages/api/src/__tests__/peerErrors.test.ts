import { describe, expect, it } from "vitest";
import { PeerError, SyncError } from "@aif/shared";
import { diagnosePeerError } from "../services/peerErrors.js";

describe("peer storage diagnostics", () => {
  it("classifies structured SQLite/OS codes without matching diagnostic text", () => {
    expect(diagnosePeerError({ code: "SQLITE_FULL", message: "redacted" }).code).toBe(
      "peer_storage_full",
    );
    expect(diagnosePeerError({ code: "ENOSPC" }).code).toBe("peer_storage_full");
    expect(diagnosePeerError({ code: "SQLITE_IOERR_WRITE" }).code).toBe("peer_storage_unavailable");
    expect(diagnosePeerError({ code: "SQLITE_CORRUPT" }).code).toBe("peer_storage_unavailable");
    expect(diagnosePeerError(new Error("SQLITE_FULL")).code).toBe("peer_request_invalid");
    expect(diagnosePeerError(null).code).toBe("peer_request_invalid");
    const peer = new PeerError("peer_revoked"),
      sync = new SyncError("invalid_ack");
    expect(diagnosePeerError(peer)).toBe(peer);
    expect(diagnosePeerError(sync)).toBe(sync);
  });
});
