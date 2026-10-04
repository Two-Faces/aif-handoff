import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import {
  codeSnapshotLocations,
  contextBlobDigest,
  continuationNotesSchema,
  makeCodeSnapshotPackage,
  snapshotDigest,
  SnapshotTransferError,
  PeerError,
  resetEnvCache,
  createSnapshotBundle,
  importSnapshotBundle,
  prepareReceivedSnapshot,
  verifyReceivedSnapshot,
  snapshotObjectFormat,
  hasSnapshotCommit,
  syncPeers,
} from "@aif/shared";
import { eq } from "drizzle-orm";
import { generatePeerIdentity } from "../services/peerIdentity.js";
import { createGitSnapshotTransferService } from "../services/gitSnapshotTransfer.js";
import type { peerRequest } from "../services/peerTransport.js";
import { dispatchPeerRequest } from "../services/peerTransport.js";

const state = { db: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => state.db,
}));
vi.mock("@aif/shared", async (original) => ({
  ...(await original<typeof import("@aif/shared")>()),
  assertTaskCheckoutDestination: vi.fn(),
  pinCodeSnapshot: vi.fn(),
  createSnapshotBundle: vi.fn((_root, _pack, incremental) =>
    Buffer.from(incremental ? "incremental fixture" : "full fixture"),
  ),
  importSnapshotBundle: vi.fn(),
  prepareReceivedSnapshot: vi.fn(),
  verifyReceivedSnapshot: vi.fn(),
  snapshotObjectFormat: vi.fn(() => "sha1"),
  hasSnapshotCommit: vi.fn(() => false),
}));
const data = await import("@aif/data");
let directory: string;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(snapshotObjectFormat).mockReturnValue("sha1");
  vi.mocked(hasSnapshotCommit).mockReturnValue(false);
  vi.mocked(importSnapshotBundle).mockReset();
  vi.mocked(createSnapshotBundle).mockImplementation((_root, _pack, incremental) =>
    Buffer.from(incremental ? "incremental fixture" : "full fixture"),
  );
  vi.mocked(verifyReceivedSnapshot).mockReset();
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  state.db.$client.close();
  state.db = createTestDb();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-transfer-service-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const project = data.createProject({
    name: "Transfer",
    rootPath: directory,
    personalMode: true,
  })!;
  const task = data.createTask({ projectId: project.id, title: "Snapshot", description: "" })!;
  const peerId = crypto.randomUUID();
  data.registerSyncPeer({
    deviceId: peerId,
    name: "Source",
    fingerprint: "a".repeat(64),
    address: "https://127.0.0.1:30001",
    projectIds: [project.id],
  });
  const checkout = data.bindProjectCheckout({
    projectId: project.id,
    localRoot: directory,
    executionEnvironment:
      process.platform === "win32"
        ? "native_windows"
        : process.platform === "darwin"
          ? "native_macos"
          : "native_linux",
    head: null,
    branch: null,
  });
  const bytes = Buffer.alloc(300_000, "x");
  const digest = contextBlobDigest(bytes);
  const context = {
    version: 1 as const,
    projectId: project.id,
    taskId: task.id,
    commitSha: "a".repeat(40),
    notes: continuationNotesSchema.parse({ goal: "Transfer", nextStep: "Inspect" }),
    plan: { text: null, revision: snapshotDigest({ text: null }) },
    files: [
      {
        path: ".ai-factory/NOTES.md",
        source: "portable" as const,
        digest,
        size: bytes.length,
        gitBlob: null,
      },
    ],
  };
  const pack = makeCodeSnapshotPackage(
    {
      version: 1,
      projectId: project.id,
      taskId: task.id,
      sourceDeviceId: peerId,
      commitSha: context.commitSha,
      baseCommit: "b".repeat(40),
      objectFormat: "sha1",
      branchLabel: null,
      parentSnapshotId: null,
      contextDigest: snapshotDigest(context),
    },
    context,
    [{ digest, base64: bytes.toString("base64") }],
  );
  data.storeCodeSnapshotPackage(pack);
  state.db
    .insert(codeSnapshotLocations)
    .values({ snapshotId: pack.id, projectRoot: directory })
    .run();
  const wire = vi.fn<typeof peerRequest>(async (input) => {
    if (input.request.kind === "snapshotManifest")
      return data.readPeerSnapshotManifest(
        peerId,
        input.request.projectId,
        input.request.snapshotId,
      );
    if (input.request.kind === "snapshotChunk")
      return data.readPeerSnapshotChunk(
        peerId,
        input.request.projectId,
        input.request.snapshotId,
        input.request.digest,
        input.request.ordinal,
      );
    throw new Error("Unexpected wire operation");
  });
  const service = createGitSnapshotTransferService(
    generatePeerIdentity(data.getLocalDevice().deviceId),
    wire,
  );
  const manifest = service.publish(project.id, pack.id);
  const request = {
    peerId,
    projectId: project.id,
    snapshotId: pack.id,
    checkoutId: checkout.id,
    worktreePath: join(directory, "next"),
  };
  return { service, request, wire, manifest, pack };
}

describe("explicit snapshot orchestration", () => {
  it("serves only project-authorized published resources through peer dispatch", () => {
    const f = fixture();
    const request = {
      kind: "snapshotManifest" as const,
      projectId: f.request.projectId,
      snapshotId: f.pack.id,
    };
    expect(dispatchPeerRequest(f.request.peerId, request, "a".repeat(64))).toEqual(f.manifest);
    expect(
      dispatchPeerRequest(
        f.request.peerId,
        { ...request, kind: "snapshotChunk", digest: f.manifest.fullBundle.digest, ordinal: 0 },
        "a".repeat(64),
      ),
    ).toMatchObject({ digest: f.manifest.fullBundle.digest, ordinal: 0 });
    expect(() =>
      dispatchPeerRequest(
        f.request.peerId,
        { ...request, projectId: crypto.randomUUID() },
        "a".repeat(64),
      ),
    ).toThrow();
    expect(() => dispatchPeerRequest(f.request.peerId, request, "f".repeat(64))).toThrow();
  });

  it("publishes full-only history for an unsupported incremental boundary without hiding real export failures", () => {
    const f = fixture();
    f.service.removeExport(f.request.projectId, f.pack.id);
    vi.mocked(createSnapshotBundle).mockImplementation((_root, _pack, incremental) => {
      if (incremental) throw new SnapshotTransferError("snapshot_invalid");
      return Buffer.from("full fixture");
    });
    expect(f.service.publish(f.request.projectId, f.pack.id).incrementalBundle).toBeNull();
    f.service.removeExport(f.request.projectId, f.pack.id);
    for (const error of [
      new SnapshotTransferError("snapshot_quota"),
      new Error("unclassified export failure"),
    ]) {
      vi.mocked(createSnapshotBundle).mockImplementation((_root, _pack, incremental) => {
        if (incremental) throw error;
        return Buffer.from("full fixture");
      });
      expect(() => f.service.publish(f.request.projectId, f.pack.id)).toThrow(error);
      expect(data.getSnapshotExport(f.request.projectId, f.pack.id)).toBeNull();
    }
    const descriptor = { ...f.pack.descriptor, baseCommit: f.pack.descriptor.commitSha };
    const unchanged = { ...f.pack, id: snapshotDigest(descriptor), descriptor };
    data.storeCodeSnapshotPackage(unchanged);
    state.db
      .insert(codeSnapshotLocations)
      .values({ snapshotId: unchanged.id, projectRoot: directory })
      .run();
    expect(f.service.publish(f.request.projectId, unchanged.id).incrementalBundle).toBeNull();
  });

  it("does not mask a corrupt incremental bundle with a full fallback and records failed readiness", async () => {
    const f = fixture();
    vi.mocked(hasSnapshotCommit).mockReturnValue(true);
    for (const error of [
      new SnapshotTransferError("snapshot_invalid"),
      new Error("unexpected import failure"),
    ]) {
      vi.mocked(importSnapshotBundle).mockImplementation(() => {
        throw error;
      });
      await expect(f.service.pull(f.request)).rejects.toThrow(error);
      const row = f.service.list(f.request.projectId)[0];
      expect(f.service.status(row.id)).toMatchObject({
        status: "blocked",
        codeReady: false,
        contextReady: false,
        errorCode: "snapshot_invalid",
      });
    }
    expect(
      f.wire.mock.calls.some(
        ([input]) =>
          input.request.kind === "snapshotChunk" &&
          input.request.digest === f.manifest.fullBundle.digest,
      ),
    ).toBe(false);
    expect(prepareReceivedSnapshot).not.toHaveBeenCalled();
  });

  it("blocks a missing peer address and cancellation after a successful chunk reply", async () => {
    const f = fixture();
    state.db
      .update(syncPeers)
      .set({ address: null })
      .where(eq(syncPeers.deviceId, f.request.peerId))
      .run();
    await expect(f.service.pull(f.request)).rejects.toThrow(
      expect.objectContaining({ code: "peer_unavailable" }),
    );
    expect(f.service.list(f.request.projectId)).toEqual([]);
    data.setSyncPeerAddress(f.request.peerId, "https://127.0.0.1:30001");
    const original = f.wire.getMockImplementation()!;
    f.wire.mockImplementation(async (input) => {
      const reply = await original(input);
      if (input.request.kind === "snapshotChunk") f.service.cancel(f.request.peerId);
      return reply;
    });
    await expect(f.service.pull(f.request)).rejects.toThrow(
      expect.objectContaining({ code: "snapshot_cancelled" }),
    );
    const row = f.service.list(f.request.projectId)[0];
    expect(f.service.status(row.id)).toMatchObject({
      receivedChunks: 0,
      errorCode: "snapshot_cancelled",
      codeReady: false,
    });
    expect(importSnapshotBundle).not.toHaveBeenCalled();
  });

  it("stops before staging or Git work if the board task is deleted while awaiting a chunk", async () => {
    const f = fixture();
    const original = f.wire.getMockImplementation()!;
    f.wire.mockImplementation(async (input) => {
      const reply = await original(input);
      if (input.request.kind === "snapshotChunk") data.deleteTask(f.pack.descriptor.taskId);
      return reply;
    });
    await expect(f.service.pull(f.request)).rejects.toThrow(
      expect.objectContaining({ code: "snapshot_missing" }),
    );
    expect(importSnapshotBundle).not.toHaveBeenCalled();
    expect(prepareReceivedSnapshot).not.toHaveBeenCalled();
  });

  it("uses durable partial chunks on retry and never prepares execution or overwrites a completed checkout", async () => {
    const f = fixture();
    expect(f.service.publish(f.request.projectId, f.pack.id)).toEqual(f.manifest);
    expect(createSnapshotBundle).toHaveBeenCalledTimes(2);
    const original = f.wire.getMockImplementation()!;
    let interrupt = true;
    f.wire.mockImplementation(async (input) => {
      if (interrupt && input.request.kind === "snapshotChunk" && input.request.ordinal === 1) {
        interrupt = false;
        throw new PeerError("peer_unavailable");
      }
      return original(input);
    });
    await expect(f.service.pull(f.request)).rejects.toThrow(PeerError);
    const id = f.service.list(f.request.projectId)[0].id;
    expect(f.service.status(id)).toMatchObject({
      status: "blocked",
      receivedChunks: 1,
      executionReady: false,
    });
    f.wire.mockClear();
    const ready = await f.service.pull(f.request);
    expect(ready).toMatchObject({
      id,
      status: "ready",
      codeReady: true,
      contextReady: true,
      executionReady: false,
    });
    expect(
      f.wire.mock.calls.some(
        ([input]) =>
          input.request.kind === "snapshotChunk" &&
          input.request.digest === f.manifest.contextBlobs[0].digest &&
          input.request.ordinal === 0,
      ),
    ).toBe(false);
    expect(data.findTaskById(f.pack.descriptor.taskId)).toMatchObject({
      worktreePath: null,
      paused: true,
      autoMode: false,
    });
    await f.service.pull(f.request);
    expect(prepareReceivedSnapshot).toHaveBeenCalledTimes(1);
    vi.mocked(verifyReceivedSnapshot).mockImplementation(() => {
      throw new SnapshotTransferError("snapshot_checkout_changed");
    });
    expect(f.service.status(id)).toMatchObject({ status: "blocked", checkoutReady: false });
    await expect(f.service.pull(f.request)).rejects.toThrow(SnapshotTransferError);
    expect(prepareReceivedSnapshot).toHaveBeenCalledTimes(1);
    f.service.remove(id);
    expect(f.service.list(f.request.projectId)).toEqual([]);
    f.service.removeExport(f.request.projectId, f.pack.id);
    expect(data.getSnapshotExport(f.request.projectId, f.pack.id)).toBeNull();
  });

  it("falls back to the complete bundle when an advertised prerequisite is unavailable", async () => {
    const f = fixture();
    vi.mocked(hasSnapshotCommit).mockReturnValue(true);
    vi.mocked(importSnapshotBundle).mockImplementationOnce(() => {
      throw new SnapshotTransferError("snapshot_base_missing");
    });
    const ready = await f.service.pull(f.request);
    expect(ready.status).toBe("ready");
    expect(importSnapshotBundle).toHaveBeenCalledTimes(2);
    expect(vi.mocked(importSnapshotBundle).mock.calls[0][3]).toBe(f.pack.descriptor.baseCommit);
    expect(vi.mocked(importSnapshotBundle).mock.calls[1][3]).toBeNull();
    expect(data.getSnapshotTransfer(ready.id).selectedBundleDigest).toBe(
      f.manifest.fullBundle.digest,
    );
  });

  it("rejects corrupt/misdirected replies and object format mismatches before Git import", async () => {
    const f = fixture();
    vi.mocked(snapshotObjectFormat).mockReturnValue("sha256");
    await expect(f.service.pull(f.request)).rejects.toThrow(
      expect.objectContaining({ code: "snapshot_format_mismatch" }),
    );
    expect(f.service.list(f.request.projectId)).toEqual([]);
    vi.mocked(snapshotObjectFormat).mockReturnValue("sha1");
    const original = f.wire.getMockImplementation()!;
    f.wire.mockImplementation(async (input) => {
      const reply = await original(input);
      if (input.request.kind === "snapshotChunk")
        return { digest: "f".repeat(64), ordinal: input.request.ordinal, base64: "YQ==" };
      return reply;
    });
    await expect(f.service.pull(f.request)).rejects.toThrow(
      expect.objectContaining({ code: "snapshot_invalid" }),
    );
    expect(importSnapshotBundle).not.toHaveBeenCalled();
    const id = f.service.list(f.request.projectId)[0].id;
    expect(f.service.status(id)).toMatchObject({ receivedChunks: 0, codeReady: false });
  });

  it("deduplicates simultaneous retries, bounds active requests and cancels outstanding reads on stop", async () => {
    const f = fixture();
    let announce!: () => void;
    const blocked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    f.wire.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new PeerError("peer_unavailable")), {
            once: true,
          });
          announce();
        }),
    );
    const first = f.service.pull(f.request);
    const firstError = expect(first).rejects.toThrow();
    await blocked;
    const retryError = expect(f.service.pull(f.request)).rejects.toThrow();
    expect(f.wire).toHaveBeenCalledTimes(1);
    await expect(
      f.service.pull({ ...f.request, worktreePath: join(directory, "other") }),
    ).rejects.toThrow(expect.objectContaining({ code: "snapshot_conflict" }));
    const secondError = expect(
      f.service.pull({ ...f.request, snapshotId: "c".repeat(64) }),
    ).rejects.toThrow();
    await expect(f.service.pull({ ...f.request, snapshotId: "d".repeat(64) })).rejects.toThrow(
      expect.objectContaining({ code: "snapshot_quota" }),
    );
    await f.service.stop();
    await Promise.all([firstError, retryError, secondError]);
    await expect(f.service.pull(f.request)).rejects.toThrow(
      expect.objectContaining({ code: "snapshot_cancelled" }),
    );
    f.service.start();
    expect(f.service.list(f.request.projectId)).toEqual([]);
  });

  it("prevents deleting an active transfer and rechecks revocation after receiving a reply", async () => {
    const f = fixture();
    const original = f.wire.getMockImplementation()!;
    let announce!: () => void;
    const blocked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    f.wire.mockImplementation(async (input) => {
      if (input.request.kind === "snapshotChunk")
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new PeerError("peer_unavailable")), {
            once: true,
          });
          announce();
        });
      return original(input);
    });
    const pending = expect(f.service.pull(f.request)).rejects.toThrow();
    await blocked;
    const id = f.service.list(f.request.projectId)[0].id;
    expect(() => f.service.remove(id)).toThrow(
      expect.objectContaining({ code: "snapshot_conflict" }),
    );
    f.service.cancel(f.request.peerId);
    await pending;
    f.service.remove(id);
    f.wire.mockImplementation(async (input) => {
      const result = await original(input);
      data.revokeSyncPeer(f.request.peerId);
      return result;
    });
    await expect(f.service.pull(f.request)).rejects.toThrow(
      expect.objectContaining({ code: "peer_revoked" }),
    );
    expect(prepareReceivedSnapshot).not.toHaveBeenCalled();
  });
});
