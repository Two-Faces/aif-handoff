import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

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
        reject(new Error(`Fixture timeout ${action}: ${errors}`));
      }, 20_000);
      const listener = (raw: unknown) => {
        const parsed = replySchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== id) return;
        clearTimeout(timer);
        child.off("message", listener);
        if (parsed.data.error) reject(new Error(parsed.data.error));
        else resolve(parsed.data.result);
      };
      child.on("message", listener);
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
