import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  launchSupervisedProcess,
  recoverSupervisedProcess,
  type ProcessHostIdentity,
  type PreparedProcessIdentity,
  type SupervisedProcess,
} from "../supervision/processSupervisor.js";

const roots: string[] = [];
const running: SupervisedProcess[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "aif-supervision-"));
  roots.push(root);
  return root;
};
async function until(condition: () => boolean, timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Fixture did not reach its expected state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    running
      .splice(0)
      .map((child) =>
        child.stop().catch(() => recoverSupervisedProcess(child.identity).catch(() => undefined)),
      ),
  );
  for (const root of roots.splice(0)) {
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("native supervisor support boundary", () => {
  it.each(["darwin", "linux"])(
    "refuses %s without substituting process-group or PID signals for proof",
    async (platform) => {
      vi.stubGlobal("process", { platform });
      const callback = vi.fn();
      await expect(
        launchSupervisedProcess({
          executable: "node",
          args: [],
          cwd: "/",
          onIdentity: callback,
          onPrepared: callback,
        }),
      ).rejects.toMatchObject({ category: "transport", adapterCode: "supervisor_unsupported" });
      await expect(recoverSupervisedProcess({} as ProcessHostIdentity)).rejects.toMatchObject({
        adapterCode: "supervisor_unsupported",
      });
      expect(callback).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(process.platform !== "win32")(
  "Windows native job supervision",
  { timeout: 20000 },
  () => {
    async function launch(
      root: string,
      code: string,
      options: Partial<Parameters<typeof launchSupervisedProcess>[0]> = {},
    ) {
      const child = await launchSupervisedProcess({
        executable: process.execPath,
        args: ["-e", code],
        cwd: root,
        onIdentity: async () => undefined,
        onPrepared: async () => undefined,
        ...options,
      });
      running.push(child);
      return child;
    }
    it("saves host identity before creation and the suspended process before it can write, preserving literal argv and output channels", async () => {
      const root = fixture(),
        marker = join(root, "started.txt"),
        order: string[] = [],
        chunks: string[] = [];
      const args = ["a b", 'quote"end', "trailing\\", "$(no shell)", "Привет"];
      const child = await launch(root, "", {
        args: [
          "-e",
          `require('fs').writeFileSync(process.argv[1],'yes');process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write('diagnostic');`,
          marker,
          ...args,
        ],
        onIdentity: async (identity) => {
          expect(identity.hostBirth).toMatch(/^\d+$/);
          expect(existsSync(marker)).toBe(false);
          order.push("identity");
        },
        onPrepared: async (identity) => {
          expect(alive(identity.pid)).toBe(true);
          expect(existsSync(marker)).toBe(false);
          order.push("prepared");
        },
        onOutput: (stream, bytes) => chunks.push(`${stream}:${bytes.toString()}`),
      });
      const result = await child.completed;
      expect(order).toEqual(["identity", "prepared"]);
      expect(chunks).toContain(`stdout:${JSON.stringify(args)}`);
      expect(chunks).toContain("stderr:diagnostic");
      expect(readFileSync(marker, "utf8")).toBe("yes");
      expect(result).toMatchObject({ activeProcesses: 0, exitCode: 0, reason: "completed" });
      expect(await child.stop()).toEqual(result);
      expect(alive(child.identity.pid)).toBe(false);
    });
    it("keeps stdin transport separate from control frames, including target-forged stop messages", async () => {
      const chunks: string[] = [];
      const child = await launch(
        fixture(),
        `process.stdin.on('data',x=>process.stdout.write(x));process.stdin.on('end',()=>process.exit(7));`,
        { onOutput: (_, bytes) => chunks.push(bytes.toString()) },
      );
      const forged = JSON.stringify({ kind: "stopped", activeProcesses: 0 });
      child.write(Buffer.from(forged));
      child.endInput();
      expect(await child.completed).toMatchObject({ exitCode: 7, activeProcesses: 0 });
      expect(chunks.join("")).toBe(forged);
      expect(() => child.write(Buffer.from("late"))).toThrow();
    });
    it("kills detached grandchildren even when the root already exited", async () => {
      const root = fixture(),
        marker = join(root, "child.txt");
      let childPid = 0;
      const code = `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},50);`)}],{detached:true,stdio:'ignore'});process.stdout.write(String(child.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.exit(0);}},10);`;
      const child = await launch(root, code, {
        onOutput: (_, bytes) => {
          childPid = Number(bytes.toString());
        },
      });
      const result = await child.completed;
      expect(result).toMatchObject({ reason: "completed", activeProcesses: 0, exitCode: 0 });
      expect(result.terminatedProcesses).toBeGreaterThanOrEqual(1);
      expect(childPid).toBeGreaterThan(0);
      expect(alive(childPid)).toBe(false);
    });
    it("stops a writing child tree on abort and retains an unrelated process", async () => {
      const root = fixture(),
        childFile = join(root, "child.json"),
        marker = join(root, "writes.txt");
      const controller = new AbortController();
      const unrelated = await launch(root, "setInterval(()=>{},100);");
      const code = `const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10);`)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childFile)},JSON.stringify({pid:child.pid}));setInterval(()=>{},100);`;
      const child = await launch(root, code, { signal: controller.signal });
      await until(() => existsSync(marker));
      controller.abort();
      expect(await child.completed).toMatchObject({ reason: "cancelled", activeProcesses: 0 });
      const descendant = JSON.parse(readFileSync(childFile, "utf8")) as { pid: number };
      expect(alive(descendant.pid)).toBe(false);
      expect(alive(child.identity.pid)).toBe(false);
      expect(alive(unrelated.identity.pid)).toBe(true);
    });
    it("does not block cancellation when a target refuses to read its full stdin pipe", async () => {
      const child = await launch(fixture(), "setInterval(()=>{},100);");
      child.write(Buffer.alloc(65536, 65));
      expect(await child.stop()).toMatchObject({ reason: "cancelled", activeProcesses: 0 });
    });
    it("rejects failed persistence before allowing the suspended child to write", async () => {
      const root = fixture(),
        marker = join(root, "must-not-exist");
      let identity: PreparedProcessIdentity | undefined;
      await expect(
        launch(root, `require('fs').writeFileSync(${JSON.stringify(marker)},'bad');`, {
          onPrepared: async (value) => {
            identity = value;
            throw new Error("journal unavailable");
          },
        }),
      ).rejects.toThrow("journal unavailable");
      expect(identity).toBeDefined();
      await until(() => !alive(identity!.hostPid));
      await until(() => !alive(identity!.pid));
      expect(existsSync(marker)).toBe(false);
      expect(await recoverSupervisedProcess(identity!)).toMatchObject({
        reason: "recovered",
        activeProcesses: 0,
      });
    });
    it("returns no stop proof after helper death; recovery checks the persisted identity and empty job", async () => {
      const child = await launch(fixture(), "setInterval(()=>{},100);");
      process.kill(child.identity.hostPid);
      await expect(child.completed).rejects.toMatchObject({ adapterCode: "supervisor_lost" });
      const recovered = await recoverSupervisedProcess(child.identity);
      expect(recovered).toMatchObject({ reason: "recovered", activeProcesses: 0 });
      expect(alive(child.identity.pid)).toBe(false);
      expect(await recoverSupervisedProcess(child.identity)).toEqual(recovered);
    });
    it("recovers a live orphan through its exact process handle and rejects changed birth metadata", async () => {
      const child = await launch(fixture(), "setInterval(()=>{},100);");
      await expect(
        recoverSupervisedProcess({
          ...child.identity,
          hostSessionId: child.identity.hostSessionId + 1,
        }),
      ).rejects.toMatchObject({ adapterCode: "supervisor_native_failed" });
      expect(alive(child.identity.hostPid)).toBe(true);
      await expect(
        recoverSupervisedProcess({ ...child.identity, hostBirth: "123" }),
      ).rejects.toMatchObject({ adapterCode: "supervisor_native_failed" });
      expect(alive(child.identity.pid)).toBe(true);
      expect(await recoverSupervisedProcess(child.identity)).toMatchObject({
        reason: "recovered",
        activeProcesses: 0,
      });
      await expect(child.completed).rejects.toMatchObject({ adapterCode: "supervisor_lost" });
      expect(alive(child.identity.hostPid)).toBe(false);
      expect(alive(child.identity.pid)).toBe(false);
    });
    it.each(["prepared", "running"])(
      "recovers after caller process death in %s state using only persisted local identity",
      async (state) => {
        const root = fixture(),
          journal = join(root, "journal.json"),
          marker = join(root, "writes.txt");
        const host = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("./fixtures/supervisorCrash.ts", import.meta.url)),
            journal,
            marker,
            state,
          ],
          { stdio: "ignore", windowsHide: true },
        );
        try {
          await until(() => existsSync(journal));
          if (state === "running") await until(() => existsSync(marker));
          const identity = JSON.parse(readFileSync(journal, "utf8")) as PreparedProcessIdentity;
          host.kill();
          await new Promise<void>((resolve) => host.once("close", () => resolve()));
          expect(await recoverSupervisedProcess(identity)).toMatchObject({
            activeProcesses: 0,
            reason: "recovered",
          });
          expect(alive(identity.pid)).toBe(false);
          expect(alive(identity.hostPid)).toBe(false);
          if (state === "prepared") expect(existsSync(marker)).toBe(false);
        } finally {
          host.kill();
        }
      },
    );
    it("rejects unsupported inputs, ambiguous environment, cancelled starts and invalid saved identities before effects", async () => {
      const root = fixture();
      for (const bad of [
        { executable: "node" },
        { cwd: "relative" },
        { args: ["nul\0"] },
        { environment: { PATH: "a", Path: "b" } },
      ]) {
        await expect(launch(root, "", bad)).rejects.toMatchObject({
          adapterCode: "supervisor_input_invalid",
        });
      }
      await expect(launch(root, "", { signal: AbortSignal.abort() })).rejects.toMatchObject({
        adapterCode: "supervisor_cancelled",
      });
      await expect(
        recoverSupervisedProcess({ version: 1 } as ProcessHostIdentity),
      ).rejects.toMatchObject({ adapterCode: "supervisor_identity_invalid" });
      let identity: ProcessHostIdentity | undefined;
      await expect(
        launch(root, "", {
          executable: join(root, "missing.exe"),
          onIdentity: async (value) => {
            identity = value;
          },
        }),
      ).rejects.toMatchObject({ adapterCode: "supervisor_native_failed" });
      expect(await recoverSupervisedProcess(identity!)).toMatchObject({
        reason: "recovered",
        activeProcesses: 0,
      });
    });
  },
);
