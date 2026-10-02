import {
  beginSnapshotTransfer,
  deleteSnapshotExport,
  deleteSnapshotTransfer,
  describeSnapshotResource,
  getSnapshotExport,
  getSnapshotExportSource,
  getSnapshotTransfer,
  loadCodeSnapshotPackage,
  listSnapshotTransfers,
  missingSnapshotChunks,
  readSnapshotResource,
  requireSyncPeer,
  resolveSnapshotTarget,
  snapshotTransferProgress,
  stageSnapshotChunk,
  storeCodeSnapshotPackage,
  recordLocalCodeSnapshot,
  storeSnapshotExport,
  updateSnapshotTransfer,
  type SnapshotPullInput,
} from "@aif/data";
import {
  assertTaskCheckoutDestination,
  createSnapshotBundle,
  hasSnapshotCommit,
  importSnapshotBundle,
  prepareReceivedSnapshot,
  snapshotChunkReplySchema,
  snapshotObjectFormat,
  snapshotPackageFromResources,
  SnapshotTransferError,
  verifyCodeSnapshotPackage,
  verifyReceivedSnapshot,
  verifySnapshotTransferManifest,
  CodeSnapshotError,
  TaskCheckoutError,
  PeerError,
  type SnapshotResource,
  type SnapshotTransferManifest,
} from "@aif/shared";
import type { PeerTlsIdentity } from "./peerIdentity.js";
import type { peerRequest } from "./peerTransport.js";
import { resolve } from "node:path";

export function publishSnapshotExport(
  projectId: string,
  snapshotId: string,
): SnapshotTransferManifest {
  const existing = getSnapshotExport(projectId, snapshotId);
  if (existing) return existing;
  const { pack, projectRoot } = getSnapshotExportSource(projectId, snapshotId);
  const resources = new Map<string, Buffer>();
  const add = (bytes: Buffer) => {
    const resource = describeSnapshotResource(bytes);
    resources.set(resource.digest, bytes);
    return resource;
  };
  const fullBundle = add(createSnapshotBundle(projectRoot, pack));
  let incrementalBundle: SnapshotTransferManifest["incrementalBundle"] = null;
  if (pack.descriptor.baseCommit !== pack.descriptor.commitSha) {
    try {
      incrementalBundle = {
        baseCommit: pack.descriptor.baseCommit,
        resource: add(createSnapshotBundle(projectRoot, pack, true)),
      };
    } catch (error) {
      // Complex history may have multiple boundary prerequisites. A verified
      // full bundle remains available instead of guessing missing ancestry.
      if (
        !(error instanceof SnapshotTransferError) ||
        !["snapshot_base_missing", "snapshot_invalid"].includes(error.code)
      )
        throw error;
    }
  }
  return storeSnapshotExport(
    {
      version: 1,
      snapshotId: pack.id,
      descriptor: pack.descriptor,
      context: pack.context,
      fullBundle,
      incrementalBundle,
      contextBlobs: pack.blobs.map((blob) => add(Buffer.from(blob.base64, "base64"))),
    },
    resources,
  );
}

export function createGitSnapshotTransferService(
  identity: PeerTlsIdentity,
  transport: typeof peerRequest,
) {
  const active = new Map<
    string,
    {
      peerId: string;
      transferId: string | null;
      worktreePath: string;
      controller: AbortController;
      promise: Promise<ReturnType<typeof snapshotTransferProgress>>;
    }
  >();
  let stopped = false;
  const errorCode = (error: unknown) =>
    error instanceof SnapshotTransferError ||
    error instanceof CodeSnapshotError ||
    error instanceof TaskCheckoutError ||
    error instanceof PeerError
      ? error.code
      : "snapshot_invalid";
  const checkoutFor = (row: ReturnType<typeof getSnapshotTransfer>) => ({
    projectRoot: row.projectRoot,
    worktreePath: row.worktreePath,
    projectId: row.projectId,
    taskId: row.manifest.descriptor.taskId,
    snapshotCommit: row.manifest.descriptor.commitSha,
  });

  async function pull(input: SnapshotPullInput) {
    const key = JSON.stringify([input.peerId, input.projectId, input.snapshotId, input.checkoutId]);
    const existing = active.get(key);
    if (existing) {
      if (existing.worktreePath !== resolve(input.worktreePath))
        throw new SnapshotTransferError("snapshot_conflict");
      return existing.promise;
    }
    if (stopped) throw new SnapshotTransferError("snapshot_cancelled");
    if (active.size >= 2) throw new SnapshotTransferError("snapshot_quota");
    const controller = new AbortController();
    let transferId: string | null = null;
    const promise = (async () => {
      const target = resolveSnapshotTarget(input);
      assertTaskCheckoutDestination(target.localRoot, input.worktreePath);
      const peer = requireSyncPeer(input.peerId);
      if (!peer.address) throw new PeerError("peer_unavailable");
      const check = () => {
        if (controller.signal.aborted) throw new SnapshotTransferError("snapshot_cancelled");
        requireSyncPeer(input.peerId, peer.fingerprint);
        resolveSnapshotTarget(input);
        if (transferId) getSnapshotTransfer(transferId);
      };
      const call = async (request: Parameters<typeof peerRequest>[0]["request"]) => {
        check();
        const result = await transport({
          address: peer.address!,
          fingerprint: peer.fingerprint,
          deviceId: input.peerId,
          identity,
          request,
          signal: controller.signal,
        });
        check();
        return result;
      };
      const manifest = verifySnapshotTransferManifest(
        await call({
          kind: "snapshotManifest",
          projectId: input.projectId,
          snapshotId: input.snapshotId,
        }),
      );
      if (snapshotObjectFormat(target.localRoot) !== manifest.descriptor.objectFormat)
        throw new SnapshotTransferError("snapshot_format_mismatch");
      const started = beginSnapshotTransfer(input, manifest);
      transferId = started.id;
      const download = async (resource: SnapshotResource) => {
        for (const ordinal of missingSnapshotChunks(started.id, resource)) {
          const reply = snapshotChunkReplySchema.parse(
            await call({
              kind: "snapshotChunk",
              projectId: input.projectId,
              snapshotId: input.snapshotId,
              digest: resource.digest,
              ordinal,
            }),
          );
          if (reply.digest !== resource.digest || reply.ordinal !== ordinal)
            throw new SnapshotTransferError("snapshot_invalid");
          stageSnapshotChunk(started.id, resource.digest, ordinal, reply.base64);
        }
        return readSnapshotResource(started.id, resource);
      };
      try {
        if (started.completed) {
          const row = getSnapshotTransfer(started.id);
          verifyReceivedSnapshot(
            checkoutFor(row),
            loadCodeSnapshotPackage(row.snapshotId, row.projectId),
          );
          updateSnapshotTransfer(started.id, {
            status: "ready",
            errorCode: null,
            codeReady: true,
            contextReady: true,
          });
          return snapshotTransferProgress(started.id);
        }
        updateSnapshotTransfer(started.id, {
          status: "downloading",
          errorCode: null,
          codeReady: false,
          contextReady: false,
        });
        for (const resource of manifest.contextBlobs) await download(resource);
        const pack = verifyCodeSnapshotPackage(
          snapshotPackageFromResources(manifest, (resource) =>
            readSnapshotResource(started.id, resource),
          ),
        );
        storeCodeSnapshotPackage(pack);
        const delta = manifest.incrementalBundle;
        const incremental = delta && hasSnapshotCommit(target.localRoot, delta.baseCommit);
        let resource = incremental ? delta.resource : manifest.fullBundle;
        updateSnapshotTransfer(started.id, { selectedBundleDigest: resource.digest });
        let bytes = await download(resource);
        check();
        try {
          importSnapshotBundle(
            target.localRoot,
            pack,
            bytes,
            incremental ? delta.baseCommit : null,
          );
        } catch (error) {
          if (
            !incremental ||
            !(error instanceof SnapshotTransferError) ||
            error.code !== "snapshot_base_missing"
          )
            throw error;
          resource = manifest.fullBundle;
          updateSnapshotTransfer(started.id, { selectedBundleDigest: resource.digest });
          bytes = await download(resource);
          check();
          importSnapshotBundle(target.localRoot, pack, bytes, null);
        }
        recordLocalCodeSnapshot(input.projectId, pack.id, target.localRoot);
        check();
        const row = getSnapshotTransfer(started.id);
        prepareReceivedSnapshot(checkoutFor(row), pack);
        check();
        updateSnapshotTransfer(started.id, {
          status: "ready",
          codeReady: true,
          contextReady: true,
          completed: true,
        });
        return snapshotTransferProgress(started.id);
      } catch (error) {
        try {
          updateSnapshotTransfer(started.id, {
            status: "blocked",
            contextReady: false,
            codeReady: false,
            errorCode: errorCode(error),
          });
        } catch {
          /* A revoked peer or unavailable storage still fails closed. */
        }
        throw error;
      }
    })();
    const run = {
      peerId: input.peerId,
      worktreePath: resolve(input.worktreePath),
      get transferId() {
        return transferId;
      },
      controller,
      promise,
    };
    active.set(key, run);
    try {
      return await promise;
    } finally {
      if (active.get(key) === run) active.delete(key);
    }
  }
  return {
    start() {
      stopped = false;
    },
    publish: publishSnapshotExport,
    pull,
    status(id: string) {
      const row = getSnapshotTransfer(id);
      if (row.status === "ready") {
        try {
          verifyReceivedSnapshot(
            checkoutFor(row),
            loadCodeSnapshotPackage(row.snapshotId, row.projectId),
          );
        } catch (error) {
          updateSnapshotTransfer(id, {
            status: "blocked",
            codeReady: false,
            contextReady: false,
            errorCode: errorCode(error),
          });
        }
      }
      return snapshotTransferProgress(id);
    },
    list(projectId: string) {
      return listSnapshotTransfers(projectId);
    },
    cancel(peerId: string) {
      for (const run of active.values()) if (run.peerId === peerId) run.controller.abort();
    },
    async stop() {
      stopped = true;
      for (const run of active.values()) run.controller.abort();
      await Promise.allSettled([...active.values()].map((run) => run.promise));
    },
    remove(id: string) {
      if ([...active.values()].some((run) => run.transferId === id))
        throw new SnapshotTransferError("snapshot_conflict");
      deleteSnapshotTransfer(id);
    },
    removeExport: deleteSnapshotExport,
  };
}
