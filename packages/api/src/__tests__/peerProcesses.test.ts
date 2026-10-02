import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { snapshotTransferManifestSchema } from "@aif/shared";

const children: ChildProcess[] = [];
const directories: string[] = [];
const readySchema = z.object({
  ready: z.literal(true),
  address: z.string(),
  identity: z.object({ deviceId: z.string(), fingerprint: z.string() }),
});
const replySchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
async function start(directory?: string) {
  const root = directory ?? mkdtempSync(join(tmpdir(), "aif-peer-process-"));
  if (!directory) directories.push(root);
  const child = fork(fileURLToPath(new URL("./fixtures/peerNode.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      DATABASE_URL: join(root, "board.sqlite"),
      PEER_FIXTURE_DIRECTORY: root,
      AIF_PERSONAL_MODE: "false",
      LOG_LEVEL: "warn",
    },
  });
  children.push(child);
  let errors = "";
  child.stderr?.on("data", (part) => {
    errors = (errors + String(part)).slice(-4000);
  });
  const ready = await new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
    child.once("message", (message) => {
      try {
        resolve(readySchema.parse(message));
      } catch (error) {
        reject(error);
      }
    });
    child.once("exit", (code) => reject(new Error(`Fixture exited ${code}: ${errors}`)));
  });
  let sequence = 0;
  const call = (action: string, args: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        child.off("message", listener);
        child.off("exit", exited);
        reject(new Error(`Fixture timeout ${action}: ${errors}`));
      }, 20_000);
      const exited = (code: number | null) => {
        clearTimeout(timer);
        child.off("message", listener);
        reject(new Error(`Fixture exited ${code}: ${errors}`));
      };
      const listener = (raw: unknown) => {
        const parsed = replySchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== id) return;
        clearTimeout(timer);
        child.off("message", listener);
        child.off("exit", exited);
        if (parsed.data.error) reject(new Error(parsed.data.error));
        else resolve(parsed.data.result);
      };
      child.on("message", listener);
      child.once("exit", exited);
      child.send({ id, action, args });
    });
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exit;
  };
  return { ...ready, root, call, kill };
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exit;
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const snapshotSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      plan: z.string().nullable(),
      paused: z.boolean(),
      autoMode: z.boolean(),
    }),
  ),
  conflicts: z.array(z.object({ field: z.string() })),
});
describe("real independent peer processes", () => {
  it("resumes code/context chunks after process death, uses full and incremental bundles, and preserves dirty roots", async () => {
    const a = await start();
    let b = await start();
    const seedSchema = z.object({
      projectId: z.string(),
      taskId: z.string(),
      snapshotId: z.string(),
      manifest: snapshotTransferManifestSchema,
    });
    const seed = seedSchema.parse(await a.call("code:seed"));
    const invitation = await a.call("invite", {
      fingerprint: b.identity.fingerprint,
      projectIds: [seed.projectId],
    });
    await b.call("pair", { address: a.address, invitation, projectIds: [seed.projectId] });
    await b.call("sync", { peerId: a.identity.deviceId });
    const binding = z.object({ id: z.string() }).parse(await b.call("code:bind", seed));
    const before = await b.call("code:target-state");
    const request = {
      peerId: a.identity.deviceId,
      projectId: seed.projectId,
      snapshotId: seed.snapshotId,
      checkoutId: binding.id,
      name: "received-first",
    };
    await b.call("drop", { kind: "snapshotChunk", after: 1 });
    await expect(b.call("code:pull", request)).rejects.toThrow("peer_unavailable");
    const records = z.array(z.object({ id: z.string() })).parse(await b.call("code:list", seed));
    expect(records).toHaveLength(1);
    expect(await b.call("code:status", records[0])).toMatchObject({
      status: "blocked",
      receivedChunks: 1,
      codeReady: false,
      contextReady: false,
      executionReady: false,
    });
    await b.kill();
    b = await start(b.root);
    const ready = z
      .object({
        id: z.string(),
        status: z.literal("ready"),
        codeReady: z.literal(true),
        contextReady: z.literal(true),
        checkoutReady: z.literal(true),
        executionReady: z.literal(false),
      })
      .parse(await b.call("code:pull", request));
    const reads = z
      .array(z.object({ digest: z.string(), ordinal: z.number() }))
      .parse(await b.call("code:reads"));
    expect(reads).not.toContainEqual({ digest: seed.manifest.contextBlobs[0].digest, ordinal: 0 });
    expect(reads.some((read) => read.digest === seed.manifest.fullBundle.digest)).toBe(true);
    expect(await b.call("code:target-state")).toEqual(before);
    expect(await b.call("code:report", ready)).toMatchObject({
      completed: true,
      selectedBundleDigest: seed.manifest.fullBundle.digest,
      head: seed.manifest.descriptor.commitSha,
      code: "code:seed\n",
      task: { paused: true, autoMode: false, worktreePath: null, sessionId: null },
    });
    expect(await b.call("code:pull", request)).toMatchObject({ id: ready.id, status: "ready" });
    await b.call("code:edit-context", ready);
    expect(await b.call("code:status", ready)).toMatchObject({
      status: "blocked",
      contextReady: false,
      checkoutReady: false,
    });
    await expect(b.call("code:pull", request)).rejects.toThrow("context_changed");

    const advanced = seedSchema.parse(await a.call("code:advance"));
    expect(advanced.manifest.incrementalBundle).not.toBeNull();
    const second = { ...request, snapshotId: advanced.snapshotId, name: "received-second" };
    await b.call("code:tamper");
    await expect(b.call("code:pull", second)).rejects.toThrow("snapshot_invalid");
    await b.call("code:reads");
    const secondReady = z.object({ id: z.string() }).parse(await b.call("code:pull", second));
    const nextReads = z
      .array(z.object({ digest: z.string(), ordinal: z.number() }))
      .parse(await b.call("code:reads"));
    expect(
      nextReads.some(
        (read) => read.digest === advanced.manifest.incrementalBundle!.resource.digest,
      ),
    ).toBe(true);
    expect(nextReads.some((read) => read.digest === advanced.manifest.fullBundle.digest)).toBe(
      false,
    );
    expect(await b.call("code:target-state")).toEqual(before);
    expect(await b.call("code:report", secondReady)).toMatchObject({
      head: advanced.manifest.descriptor.commitSha,
      code: "code:advance\n",
      progress: { status: "ready", executionReady: false },
    });
    const crashSnapshot = seedSchema.parse(await a.call("code:advance"));
    const crashRequest = {
      ...request,
      snapshotId: crashSnapshot.snapshotId,
      name: "received-crash",
    };
    await b.call("code:crash-on-checkout");
    await expect(b.call("code:pull", crashRequest)).rejects.toThrow("Fixture exited 23");
    b = await start(b.root);
    expect(await b.call("code:pull", crashRequest)).toMatchObject({
      status: "ready",
      codeReady: true,
      contextReady: true,
    });
    expect(await b.call("code:reads")).toEqual([]);
    expect(await b.call("code:target-state")).toEqual(before);
    const republished = snapshotTransferManifestSchema.parse(
      await b.call("code:publish", advanced),
    );
    expect(republished.snapshotId).toBe(advanced.snapshotId);
    await a.call("address", { peerId: b.identity.deviceId, address: b.address });
    const reverseBinding = z.object({ id: z.string() }).parse(await a.call("code:bind", seed));
    const base = z
      .object({ sha: z.string(), commit: z.string() })
      .parse(await a.call("code:base-object", { snapshotId: advanced.snapshotId }));
    expect(await a.call("code:incomplete-base", base)).toBe(base.sha);
    const reverseBefore = await a.call("code:target-state");
    const reverse = z.object({ id: z.string(), status: z.literal("ready") }).parse(
      await a.call("code:pull", {
        peerId: b.identity.deviceId,
        projectId: seed.projectId,
        snapshotId: advanced.snapshotId,
        checkoutId: reverseBinding.id,
        name: "received-back",
      }),
    );
    expect(await a.call("code:target-state")).toEqual(reverseBefore);
    expect(await a.call("code:report", reverse)).toMatchObject({
      head: advanced.manifest.descriptor.commitSha,
    });
    const reverseReads = z
      .array(z.object({ digest: z.string(), ordinal: z.number() }))
      .parse(await a.call("code:reads"));
    expect(
      reverseReads.some((read) => read.digest === republished.incrementalBundle!.resource.digest),
    ).toBe(true);
    expect(reverseReads.some((read) => read.digest === republished.fullBundle.digest)).toBe(true);
    await a.call("revoke", { peerId: b.identity.deviceId });
    await expect(b.call("code:pull", second)).rejects.toThrow();
  }, 120_000);

  it("resumes interrupted bootstrap, exchanges offline edits, recovers a lost ACK after crash, and converges", async () => {
    const a = await start();
    let b = await start();
    const seed = z
      .object({ projectId: z.string(), taskId: z.string() })
      .parse(await a.call("seed", { count: 40 }));
    const invitation = await a.call("invite", {
      fingerprint: b.identity.fingerprint,
      projectIds: [seed.projectId],
    });
    await b.call("pair", { address: a.address, invitation, projectIds: [seed.projectId] });
    await b.call("drop", { kind: "checkpointRead" });
    await expect(b.call("sync", { peerId: a.identity.deviceId })).rejects.toThrow(
      "peer_unavailable",
    );
    await b.kill();
    b = await start(b.root);
    await b.call("sync", { peerId: a.identity.deviceId });
    let right = snapshotSchema.parse(await b.call("snapshot", seed));
    expect(right.tasks).toHaveLength(40);
    expect(right.tasks.every((task) => task.paused && !task.autoMode)).toBe(true);
    await a.call("edit", { ...seed, patch: { title: "A offline", plan: "A plan" } });
    await b.call("edit", { ...seed, patch: { description: "B offline", plan: "B plan" } });
    await b.call("drop", { kind: "exchange" });
    await expect(b.call("sync", { peerId: a.identity.deviceId })).rejects.toThrow(
      "peer_unavailable",
    );
    await b.kill();
    b = await start(b.root);
    await b.call("sync", { peerId: a.identity.deviceId });
    right = snapshotSchema.parse(await b.call("snapshot", seed));
    expect(right.tasks.find((task) => task.id === seed.taskId)).toMatchObject({
      title: "A offline",
      description: "B offline",
    });
    expect(right.conflicts).toEqual([{ field: "plan" }]);
    await b.call("resolve", seed);
    await b.call("sync", { peerId: a.identity.deviceId });
    const left = snapshotSchema.parse(await a.call("snapshot", seed));
    expect(left.conflicts).toEqual([]);
    expect(left.tasks.find((task) => task.id === seed.taskId)?.plan).toBe("Resolved");
    await a.call("delete", seed);
    await b.call("sync", { peerId: a.identity.deviceId });
    expect(snapshotSchema.parse(await b.call("snapshot", seed)).tasks).toHaveLength(39);
    await a.call("revoke", { peerId: b.identity.deviceId });
    await expect(b.call("sync", { peerId: a.identity.deviceId })).rejects.toThrow();
  }, 60_000);
});
