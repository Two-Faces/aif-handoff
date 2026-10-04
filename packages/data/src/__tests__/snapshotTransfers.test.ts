import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import {
  codeSnapshotLocations,
  continuationNotesSchema,
  contextBlobDigest,
  makeCodeSnapshotPackage,
  projectCheckouts,
  snapshotChunks,
  snapshotDigest,
  snapshotTransfers,
  verifySnapshotTransferManifest,
  resetEnvCache,
  type SnapshotTransferManifest,
} from "@aif/shared";

const state = { db: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => state.db,
}));
const data = await import("../index.js");
let directory: string;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  state.db.$client.close();
  state.db = createTestDb();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-transfer-journal-")));
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
  const task = data.createTask({ projectId: project.id, title: "Receive", description: "" })!;
  const peerId = crypto.randomUUID();
  data.registerSyncPeer({
    deviceId: peerId,
    name: "Source",
    fingerprint: "b".repeat(64),
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
  const bytes = randomBytes(300_000);
  const digest = contextBlobDigest(bytes);
  const context = {
    version: 1 as const,
    projectId: project.id,
    taskId: task.id,
    commitSha: "a".repeat(40),
    notes: continuationNotesSchema.parse({ goal: "Transfer", nextStep: "Review" }),
    plan: { text: null, revision: snapshotDigest({ text: null }) },
    files: [
      {
        path: "docs/agent-context/check.md",
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
      baseCommit: context.commitSha,
      objectFormat: "sha1",
      branchLabel: null,
      parentSnapshotId: null,
      contextDigest: snapshotDigest(context),
    },
    context,
    [{ digest, base64: bytes.toString("base64") }],
  );
  const bundle = randomBytes(550_000);
  const fullBundle = data.describeSnapshotResource(bundle);
  const resource = data.describeSnapshotResource(bytes);
  const manifest: SnapshotTransferManifest = {
    version: 1,
    snapshotId: pack.id,
    descriptor: pack.descriptor,
    context,
    fullBundle,
    incrementalBundle: null,
    contextBlobs: [resource],
  };
  const input = {
    peerId,
    projectId: project.id,
    snapshotId: pack.id,
    checkoutId: checkout.id,
    worktreePath: join(directory, "incoming"),
  };
  return {
    project,
    task,
    peerId,
    pack,
    input,
    manifest,
    resource,
    resources: new Map([
      [fullBundle.digest, bundle],
      [digest, bytes],
    ]),
  };
}

describe("durable snapshot transfer journal", () => {
  it("keeps partial chunks resumable and verifies each chunk and final resource before readiness", () => {
    const f = fixture();
    expect(() => data.getSnapshotTransfer("missing")).toThrow();
    expect(() => data.getSnapshotExportSource(f.project.id, f.pack.id)).toThrow();
    data.storeCodeSnapshotPackage(f.pack);
    expect(() => data.getSnapshotExportSource(f.project.id, f.pack.id)).toThrow();
    state.db
      .insert(codeSnapshotLocations)
      .values({ snapshotId: f.pack.id, projectRoot: directory })
      .run();
    expect(data.getSnapshotExportSource(f.project.id, f.pack.id).pack).toEqual(f.pack);
    expect(data.storeSnapshotExport(f.manifest, f.resources)).toEqual(f.manifest);
    expect(data.storeSnapshotExport(f.manifest, f.resources)).toEqual(f.manifest);
    const row = data.beginSnapshotTransfer(f.input, f.manifest);
    expect(data.beginSnapshotTransfer(f.input, f.manifest)).toEqual(row);
    expect(data.snapshotTransferProgress(row.id)).toMatchObject({
      status: "downloading",
      codeReady: false,
      contextReady: false,
      checkoutReady: false,
      executionReady: false,
    });
    const first = data.readPeerSnapshotChunk(
      f.peerId,
      f.project.id,
      f.pack.id,
      f.resource.digest,
      0,
    );
    expect(() =>
      data.stageSnapshotChunk(row.id, first.digest, first.ordinal, "Y29ycnVwdA=="),
    ).toThrow();
    expect(data.missingSnapshotChunks(row.id, f.resource)).toEqual([0, 1]);
    data.stageSnapshotChunk(row.id, first.digest, first.ordinal, first.base64);
    data.stageSnapshotChunk(row.id, first.digest, first.ordinal, first.base64);
    expect(data.missingSnapshotChunks(row.id, f.resource)).toEqual([1]);
    expect(() => data.readSnapshotResource(row.id, f.resource)).toThrow();
    const second = data.readPeerSnapshotChunk(
      f.peerId,
      f.project.id,
      f.pack.id,
      f.resource.digest,
      1,
    );
    data.stageSnapshotChunk(row.id, second.digest, second.ordinal, second.base64);
    expect(data.readSnapshotResource(row.id, f.resource)).toEqual(
      f.resources.get(f.resource.digest),
    );
    data.updateSnapshotTransfer(row.id, { selectedBundleDigest: f.manifest.fullBundle.digest });
    expect(data.snapshotTransferProgress(row.id)).toMatchObject({
      receivedChunks: 2,
      totalChunks: 5,
      codeReady: false,
    });
    state.db
      .update(snapshotChunks)
      .set({ base64: "bad" })
      .where(eq(snapshotChunks.ownerId, `incoming:${row.id}`))
      .run();
    expect(() => data.readSnapshotResource(row.id, f.resource)).toThrow();
    expect(() =>
      data.stageSnapshotChunk(row.id, first.digest, first.ordinal, first.base64),
    ).toThrow();
  });

  it("enforces project scope and current peer authorization even for cached digests", () => {
    const f = fixture();
    data.storeSnapshotExport(f.manifest, f.resources);
    const row = data.beginSnapshotTransfer(f.input, f.manifest);
    expect(() => data.readPeerSnapshotManifest(f.peerId, crypto.randomUUID(), f.pack.id)).toThrow();
    expect(() =>
      data.readPeerSnapshotChunk(f.peerId, f.project.id, f.pack.id, "f".repeat(64), 0),
    ).toThrow();
    expect(() =>
      data.readPeerSnapshotChunk(f.peerId, f.project.id, f.pack.id, f.resource.digest, 99),
    ).toThrow();
    expect(() => data.stageSnapshotChunk(row.id, "f".repeat(64), 0, "")).toThrow();
    expect(() => data.missingSnapshotChunks(row.id, { ...f.resource, size: 1 })).toThrow();
    data.revokeSyncPeer(f.peerId);
    expect(() => data.readPeerSnapshotManifest(f.peerId, f.project.id, f.pack.id)).toThrow();
    expect(() => data.getSnapshotTransfer(row.id)).toThrow();
    data.deleteSnapshotTransfer(row.id);
    expect(state.db.select().from(snapshotTransfers).all()).toEqual([]);
    data.deleteSnapshotExport(f.project.id, f.pack.id);
    expect(data.getSnapshotExport(f.project.id, f.pack.id)).toBeNull();
  });

  it("rejects swapped manifests, incomplete exports and changed local bindings", () => {
    const f = fixture();
    expect(() => data.storeSnapshotExport(f.manifest, new Map())).toThrow();
    expect(data.getSnapshotExport(f.project.id, f.pack.id)).toBeNull();
    const tampered = structuredClone(f.manifest);
    tampered.context.notes.goal = "swapped";
    expect(() => verifySnapshotTransferManifest(tampered)).toThrow();
    expect(() =>
      data.beginSnapshotTransfer({ ...f.input, snapshotId: "c".repeat(64) }, f.manifest),
    ).toThrow();
    expect(() =>
      data.beginSnapshotTransfer({ ...f.input, checkoutId: crypto.randomUUID() }, f.manifest),
    ).toThrow();
    const row = data.beginSnapshotTransfer(f.input, f.manifest);
    expect(() =>
      data.beginSnapshotTransfer(
        { ...f.input, worktreePath: join(directory, "other") },
        f.manifest,
      ),
    ).toThrow();
    state.db
      .update(projectCheckouts)
      .set({ localRoot: join(directory, "moved") })
      .where(eq(projectCheckouts.id, f.input.checkoutId))
      .run();
    expect(() => data.getSnapshotTransfer(row.id)).toThrow();
    state.db
      .update(projectCheckouts)
      .set({ executionEnvironment: "wsl" })
      .where(eq(projectCheckouts.id, f.input.checkoutId))
      .run();
    expect(() => data.resolveSnapshotTarget(f.input)).toThrow();
  });

  it("bounds declared storage before accepting any remote chunks", () => {
    const f = fixture();
    const huge = structuredClone(f.manifest);
    huge.fullBundle = {
      digest: "c".repeat(64),
      size: 64 * 1024 * 1024,
      chunks: Array(256).fill("d".repeat(64)),
    };
    huge.descriptor.baseCommit = "b".repeat(40);
    huge.incrementalBundle = {
      baseCommit: huge.descriptor.baseCommit,
      resource: {
        digest: "e".repeat(64),
        size: 64 * 1024 * 1024,
        chunks: Array(256).fill("f".repeat(64)),
      },
    };
    for (let i = 0; i < 4; i++) {
      huge.context.notes.nextStep = `step ${i}`;
      huge.descriptor.contextDigest = snapshotDigest(huge.context);
      huge.snapshotId = snapshotDigest(huge.descriptor);
      const request = {
        ...f.input,
        snapshotId: huge.snapshotId,
        worktreePath: join(directory, `incoming-${i}`),
      };
      if (i < 3) data.beginSnapshotTransfer(request, huge);
      else
        expect(() => data.beginSnapshotTransfer(request, huge)).toThrow(
          expect.objectContaining({ code: "snapshot_quota" }),
        );
    }
    expect(state.db.select().from(snapshotChunks).all()).toEqual([]);
  });
});
