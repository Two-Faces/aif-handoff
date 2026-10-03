import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  launchSupervisedProcess,
  recoverSupervisedProcess,
  type SupervisedProcessInput,
  type SupervisedProcess,
  type ProcessHostIdentity,
  type PreparedProcessIdentity,
} from "../supervision/processSupervisor.js";

const roots: string[] = [],
  running: SupervisedProcess[] = [];
const saved: ProcessHostIdentity[] = [];
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-mac-native-")));
  roots.push(root);
  return root;
}
async function until(condition: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Native fixture did not reach its expected state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function launch(root: string, code: string, options: Partial<SupervisedProcessInput> = {}) {
  const child = await launchSupervisedProcess({
    executable: process.execPath,
    args: ["-e", code],
    cwd: root,
    onIdentity: async (identity) => {
      saved.push(identity);
    },
    onPrepared: async () => undefined,
    ...options,
  });
  running.push(child);
  return child;
}
afterEach(async () => {
  for (const child of running.splice(0)) await child.stop().catch(() => undefined);
  for (const identity of saved.splice(0)) await recoverSupervisedProcess(identity);
  for (const root of roots.splice(0)) {
    expect(root.startsWith(realpathSync.native(tmpdir()) + "/")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
describe.skipIf(process.platform !== "darwin")(
  "macOS native launchd coalition supervision",
  { timeout: 30000 },
  () => {
    it("persists both barriers before user code runs and preserves literal arguments and separate output", async () => {
      const root = fixture(),
        marker = join(root, "started.txt"),
        order: string[] = [],
        output: string[] = [];
      const args = ["a b", 'quote"end', "$(literal)", "Привет"];
      const child = await launch(root, "", {
        args: [
          "-e",
          "require('fs').writeFileSync(process.argv[1],'yes');process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write('diagnostic')",
          marker,
          ...args,
        ],
        onIdentity: async (identity) => {
          saved.push(identity);
          order.push("host");
          expect(existsSync(marker)).toBe(false);
        },
        onPrepared: async (identity) => {
          expect(identity.mechanism).toBe("macos_coalition_v1");
          expect(alive(identity.pid)).toBe(true);
          expect(existsSync(marker)).toBe(false);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(existsSync(marker)).toBe(false);
          order.push("prepared");
        },
        onOutput: (stream, bytes) => output.push(stream + ":" + bytes.toString()),
      });
      expect(await child.completed).toMatchObject({
        reason: "completed",
        activeProcesses: 0,
        exitCode: 0,
      });
      expect(order).toEqual(["host", "prepared"]);
      expect(readFileSync(marker, "utf8")).toBe("yes");
      expect(output.join("")).toContain(JSON.stringify(args));
      expect(output.join("")).toContain("stderr:diagnostic");
      expect(alive(child.identity.hostPid)).toBe(false);
      expect(alive(child.identity.pid)).toBe(false);
    });
    it("treats target-forged control JSON as data and stops while stdin is full", async () => {
      const root = fixture(),
        output: string[] = [];
      const echo = await launch(
        root,
        "process.stdin.on('data',x=>process.stdout.write(x));process.stdin.on('end',()=>process.exit(7))",
        { onOutput: (_, bytes) => output.push(bytes.toString()) },
      );
      const forged = '{"kind":"stopped","activeProcesses":0}';
      echo.write(Buffer.from(forged));
      echo.endInput();
      echo.endInput();
      expect(() => echo.write(Buffer.from("after EOF"))).toThrow();
      expect(await echo.completed).toMatchObject({ exitCode: 7, activeProcesses: 0 });
      expect(output.join("")).toBe(forged);
      const blocked = await launch(root, "setInterval(()=>{},100)");
      blocked.write(Buffer.alloc(65536, 65));
      expect(await blocked.stop()).toMatchObject({ reason: "cancelled", activeProcesses: 0 });
    });
    it("accounts for and kills a detached grandchild after the root and intermediate process exit", async () => {
      const root = fixture(),
        marker = join(root, "grandchild.txt");
      const grandchild =
        "require('fs').writeFileSync(" +
        JSON.stringify(marker) +
        ",String(process.pid));setInterval(()=>{},50)";
      const intermediate =
        "require('child_process').spawn(process.execPath,['-e'," +
        JSON.stringify(grandchild) +
        "],{detached:true,stdio:'ignore'}).unref()";
      const code =
        "const fs=require('fs');require('child_process').spawn(process.execPath,['-e'," +
        JSON.stringify(intermediate) +
        "],{detached:true,stdio:'ignore'}).unref();const t=setInterval(()=>{if(fs.existsSync(" +
        JSON.stringify(marker) +
        ")){clearInterval(t);process.exit(0)}},10)";
      const child = await launch(root, code);
      const stopped = await child.completed;
      expect(stopped).toMatchObject({ reason: "completed", exitCode: 0, activeProcesses: 0 });
      expect(stopped.terminatedProcesses).toBeGreaterThanOrEqual(1);
      expect(alive(Number(readFileSync(marker, "utf8")))).toBe(false);
    });
    it("stops a writing descendant without killing an unrelated process", async () => {
      const root = fixture(),
        marker = join(root, "writes.txt");
      const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], {
        stdio: "ignore",
      });
      try {
        const nested =
          "const fs=require('fs');setInterval(()=>fs.appendFileSync(" +
          JSON.stringify(marker) +
          ",'x'),10)";
        const child = await launch(
          root,
          "require('child_process').spawn(process.execPath,['-e'," +
            JSON.stringify(nested) +
            "],{detached:true,stdio:'ignore'});setInterval(()=>{},100)",
        );
        await until(() => existsSync(marker));
        expect(await child.stop()).toMatchObject({ reason: "cancelled", activeProcesses: 0 });
        const length = readFileSync(marker).length;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(readFileSync(marker).length).toBe(length);
        expect(alive(unrelated.pid!)).toBe(true);
      } finally {
        unrelated.kill();
      }
    });
    it("rejects failed preparation before writes and recovers the original native scope", async () => {
      const root = fixture(),
        marker = join(root, "forbidden.txt");
      let prepared: PreparedProcessIdentity | undefined;
      await expect(
        launch(root, "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'bad')", {
          onPrepared: async (identity) => {
            prepared = identity;
            throw new Error("journal unavailable");
          },
        }),
      ).rejects.toThrow("journal unavailable");
      expect(prepared).toBeDefined();
      expect(await recoverSupervisedProcess(prepared!)).toMatchObject({
        reason: "recovered",
        activeProcesses: 0,
      });
      expect(existsSync(marker)).toBe(false);
    });
    it("keeps helper death uncertain and rejects wrong birth/boot before recovering a live orphan", async () => {
      const root = fixture(),
        marker = join(root, "writes.txt");
      const child = await launch(
        root,
        "const fs=require('fs');setInterval(()=>fs.appendFileSync(" +
          JSON.stringify(marker) +
          ",'x'),10)",
      );
      if (child.identity.mechanism !== "macos_coalition_v1")
        throw new Error("Expected Mac receipt");
      await until(() => existsSync(marker));
      await expect(
        recoverSupervisedProcess({ ...child.identity, hostBirth: "123" }),
      ).rejects.toMatchObject({ adapterCode: "supervisor_native_failed" });
      expect(alive(child.identity.pid)).toBe(true);
      await expect(
        recoverSupervisedProcess({
          ...child.identity,
          bootSessionId: "019b3812-6320-4000-8000-999999999999",
        }),
      ).rejects.toMatchObject({ adapterCode: "supervisor_identity_invalid" });
      process.kill(child.identity.hostPid, "SIGKILL");
      await expect(child.completed).rejects.toMatchObject({ adapterCode: "supervisor_lost" });
      expect(await recoverSupervisedProcess(child.identity)).toMatchObject({
        reason: "recovered",
        activeProcesses: 0,
      });
      expect(alive(child.identity.pid)).toBe(false);
    });
    it.each(["prepared", "running"])(
      "recovers a persisted receipt after caller death in %s state",
      async (state) => {
        const root = fixture(),
          journal = join(root, "journal.json"),
          marker = join(root, "writes.txt");
        const caller = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("./fixtures/supervisorCrash.ts", import.meta.url)),
            journal,
            marker,
            state,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let diagnostics = "";
        caller.stderr.on("data", (bytes) => {
          diagnostics += bytes.toString();
        });
        try {
          await until(() => existsSync(journal) || caller.exitCode !== null);
          expect(caller.exitCode, diagnostics).toBeNull();
          if (state === "running") await until(() => existsSync(marker));
          const identity = JSON.parse(readFileSync(journal, "utf8")) as PreparedProcessIdentity;
          saved.push(identity);
          caller.kill("SIGKILL");
          await new Promise<void>((resolve) => caller.once("close", () => resolve()));
          expect(await recoverSupervisedProcess(identity)).toMatchObject({
            reason: "recovered",
            activeProcesses: 0,
          });
          expect(alive(identity.hostPid)).toBe(false);
          expect(alive(identity.pid)).toBe(false);
          if (state === "prepared") expect(existsSync(marker)).toBe(false);
        } finally {
          caller.kill("SIGKILL");
        }
      },
    );
  },
);
