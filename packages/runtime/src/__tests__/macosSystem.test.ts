import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMacNativeSystem,
  macHostPaths,
  macServicePlist,
} from "../supervision/macosSystem.js";
import { macosNativeSource } from "../supervision/macosNativeSource.js";
import type { MacProcessHostIdentity } from "@aif/shared";

const mock = vi.hoisted(() => ({
  run: vi.fn(),
  spawn: vi.fn(),
  files: new Map<
    string,
    { directory: boolean; uid: number; mode: number; bytes: Buffer; symlink?: boolean }
  >(),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify: convert } = await import("node:util");
  const fn = Object.assign(() => undefined, { [convert.custom]: mock.run });
  return { ...actual, execFile: fn, spawn: mock.spawn };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const owned = (p: string) => p.startsWith("/private/tmp/aif-supervisor-");
  return {
    ...actual,
    realpathSync: (p: string) => (p === "/private/tmp" || owned(p) ? p : actual.realpathSync(p)),
    mkdirSync: (p: string) => {
      if (!owned(p)) throw new Error("Unexpected mock write");
      mock.files.set(p, { directory: true, uid: 501, mode: 0o700, bytes: Buffer.alloc(0) });
    },
    writeFileSync: (p: string, bytes: string | Buffer) => {
      if (!owned(p)) throw new Error("Unexpected mock write");
      mock.files.set(p, { directory: false, uid: 501, mode: 0o600, bytes: Buffer.from(bytes) });
    },
    readFileSync: (p: string) => (owned(p) ? mock.files.get(p)!.bytes : actual.readFileSync(p)),
    existsSync: (p: string) => (owned(p) ? mock.files.has(p) : actual.existsSync(p)),
    lstatSync: (p: string) => {
      if (!owned(p)) return actual.lstatSync(p);
      const value = mock.files.get(p);
      if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {
        uid: value.uid,
        mode: value.mode,
        isFile: () => !value.directory,
        isDirectory: () => value.directory,
        isSymbolicLink: () => Boolean(value.symlink),
      };
    },
    chmodSync: (p: string, mode: number) => {
      mock.files.get(p)!.mode = mode;
    },
    rmSync: (p: string) => {
      if (!owned(p)) throw new Error("Unexpected mock removal");
      for (const key of mock.files.keys())
        if (key === p || key.startsWith(p + "/")) mock.files.delete(key);
    },
  };
});
const boot = "019b3812-6320-4000-8000-999999999999";
function nativeIdentity(image: string, pid = 100) {
  return {
    pid,
    uid: 501,
    birth: "123",
    uniqueId: "9007199254740993",
    pidVersion: 4,
    coalitionId: "40",
    image,
    stopped: false,
  };
}
function nativeFailure(stage: string, nativeCode: number) {
  return Object.assign(new Error("diagnostic only"), {
    code: 1,
    stdout: JSON.stringify({ kind: "error", stage, nativeCode }),
    stderr: "",
  });
}
async function execute(file: string, args: string[]) {
  if (file === "/usr/bin/xcrun")
    return { stdout: args[0] === "--find" ? "/usr/bin/clang\n" : "/SDK\n", stderr: "" };
  if (file === "/usr/bin/clang") {
    mock.files.set(args.at(-1)!, {
      directory: false,
      uid: 501,
      mode: 0o755,
      bytes: Buffer.from("compiled helper"),
    });
    return { stdout: "", stderr: "" };
  }
  if (file === "/bin/launchctl") return { stdout: "", stderr: "" };
  if (args[0] === "capabilities")
    return {
      stdout: JSON.stringify({
        kind: "capabilities",
        bootSessionId: boot,
        uid: 501,
        identity: nativeIdentity(file),
      }),
      stderr: "",
    };
  if (args[0] === "identity")
    return {
      stdout: JSON.stringify({ kind: "identity", identity: nativeIdentity(file, Number(args[1])) }),
      stderr: "",
    };
  if (args[0] === "usage")
    return { stdout: '{"kind":"usage","started":"2","exited":"1","active":"1"}', stderr: "" };
  if (args[0] === "recover")
    return { stdout: '{"kind":"recovered","activeProcesses":0}', stderr: "" };
  throw new Error("Unexpected native command");
}
beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "darwin", getuid: () => 501 });
  mock.files.clear();
  mock.run.mockReset().mockImplementation(execute);
  mock.spawn.mockReset().mockImplementation((file: string) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ kind: "peer", identity: nativeIdentity(file, 200) }));
      child.emit("close", 0);
    });
    return child;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mock.files.clear();
});
describe("macOS host preparation boundary (simulated OS)", () => {
  it("compiles bundled source with a clean environment and launches only its UUID-scoped service", async () => {
    vi.stubEnv("DYLD_INSERT_LIBRARIES", "/task/override");
    vi.stubEnv("NODE_OPTIONS", "--task-override");
    const system = await createMacNativeSystem();
    expect(mock.files.get(system.paths.root + "/host.m")!.bytes.toString()).toBe(macosNativeSource);
    const compile = mock.run.mock.calls.find((x) => x[0] === "/usr/bin/clang")!;
    expect(compile[1]).toContain("-framework");
    expect(compile[1]).toContain("Foundation");
    expect(compile[2].env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(compile[2].env.NODE_OPTIONS).toBeUndefined();
    await system.bootstrap();
    const plist = mock.files.get(system.paths.plist)!.bytes.toString();
    expect(plist).toContain("<string>/usr/bin/env</string><string>-i</string>");
    expect(plist).toContain("<key>KeepAlive</key><false/>");
    expect(plist).not.toContain("/bin/sh");
    expect(mock.run).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["bootstrap", "gui/501", system.paths.plist],
      expect.any(Object),
    );
    expect(await system.inspect(100)).toMatchObject({ uniqueId: "9007199254740993" });
    const socket = new Socket();
    expect(await system.peer(socket)).toMatchObject({ pid: 200, uid: 501 });
    expect(mock.spawn).toHaveBeenCalledWith(
      system.paths.executable,
      ["peer"],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe", socket],
      }),
    );
    expect(await system.usage("50")).toMatchObject({ active: "1" });
    expect(await system.removeService({ id: system.id, hostUid: 501 })).toBe(true);
    system.dispose();
    expect(mock.files.size).toBe(0);
  });
  it("does no native preparation on unsupported platforms or without native UID APIs", async () => {
    vi.stubGlobal("process", { platform: "linux" });
    await expect(createMacNativeSystem()).rejects.toMatchObject({
      adapterCode: "supervisor_unsupported",
    });
    vi.stubGlobal("process", { platform: "darwin" });
    await expect(createMacNativeSystem()).rejects.toMatchObject({
      adapterCode: "supervisor_unsupported",
    });
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.files.size).toBe(0);
  });
  it.each(["toolchain", "compile", "capability"] as const)(
    "cleans preparation after %s failure before any service is registered",
    async (stage) => {
      mock.run.mockImplementation(async (file, args) => {
        if (stage === "toolchain" && file === "/usr/bin/xcrun")
          throw Object.assign(new Error("missing compiler"), {
            code: 1,
            stderr: "toolchain unavailable",
          });
        if (stage === "compile" && file === "/usr/bin/clang")
          throw Object.assign(new Error("compile"), { code: 1, stderr: "clang diagnostic" });
        if (stage === "capability" && args[0] === "capabilities")
          throw nativeFailure("audit_fence_unavailable", 71);
        return execute(file, args);
      });
      await expect(createMacNativeSystem()).rejects.toMatchObject({ category: "transport" });
      expect(mock.files.size).toBe(0);
      expect(mock.run.mock.calls.some((x) => x[0] === "/bin/launchctl")).toBe(false);
    },
  );
  it("refuses to execute a substituted binary and refuses deletion after directory ownership changes", async () => {
    const system = await createMacNativeSystem();
    mock.files.get(system.paths.executable)!.bytes = Buffer.from("changed");
    const before = mock.run.mock.calls.length;
    await expect(system.inspect(100)).rejects.toMatchObject({
      adapterCode: "supervisor_binary_changed",
    });
    expect(mock.run.mock.calls.length).toBe(before);
    mock.files.get(system.paths.root)!.uid = 502;
    expect(() => system.dispose()).toThrow(
      expect.objectContaining({ adapterCode: "supervisor_directory_changed" }),
    );
    expect(mock.files.has(system.paths.root)).toBe(true);
  });
  it("accepts only the structured ESRCH result for the requested query", async () => {
    const system = await createMacNativeSystem();
    mock.run.mockImplementation(async (_file, args) => {
      throw nativeFailure(args[0] === "identity" ? "inspect" : "usage", 3);
    });
    expect(await system.inspect(100)).toBeNull();
    expect(await system.usage("50")).toEqual({ absent: true });
    mock.run.mockRejectedValue(nativeFailure("permission", 3));
    await expect(system.usage("50")).rejects.toMatchObject({
      adapterCode: "supervisor_native_failed",
    });
    system.dispose();
  });
  it("rejects malformed native protocol, inconsistent counters and wrong process identities", async () => {
    const system = await createMacNativeSystem();
    for (const stdout of [
      "not json",
      "[]",
      '{"kind":"usage","started":"bad","exited":"1","active":"1"}',
      '{"kind":"usage","started":"3","exited":"1","active":"1"}',
    ]) {
      mock.run.mockResolvedValue({ stdout, stderr: "" });
      await expect(system.usage("50")).rejects.toMatchObject({
        adapterCode: "supervisor_protocol_invalid",
      });
    }
    mock.run.mockResolvedValue({ stdout: '{"kind":"identity","identity":null}', stderr: "" });
    await expect(system.inspect(100)).rejects.toMatchObject({
      adapterCode: "supervisor_protocol_invalid",
    });
    mock.run.mockResolvedValue({
      stdout: '{"kind":"error","stage":"usage","nativeCode":3}',
      stderr: "",
    });
    await expect(system.usage("50")).rejects.toMatchObject({
      adapterCode: "supervisor_native_lost",
    });
    system.dispose();
  });
  it("validates recovery boot/user/scope before invoking any stop operation", async () => {
    const system = await createMacNativeSystem();
    const identity: MacProcessHostIdentity = {
      version: 1,
      mechanism: "macos_coalition_v1",
      id: system.id,
      serviceName: system.paths.label,
      hostPid: 123,
      hostBirth: "123",
      hostUid: 501,
      hostUniqueId: "99",
      hostPidVersion: 4,
      bootSessionId: boot,
      coalitionId: "50",
    };
    for (const patch of [{ hostUid: 502 }, { bootSessionId: randomUUID() }, { coalitionId: "40" }])
      await expect(system.recover({ ...identity, ...patch })).rejects.toMatchObject({
        adapterCode: "supervisor_identity_invalid",
      });
    expect(mock.run.mock.calls.some((x) => x[1][0] === "recover")).toBe(false);
    await system.recover(identity);
    expect(mock.run.mock.calls.some((x) => x[1][0] === "recover")).toBe(true);
    await expect(system.inspect(0)).rejects.toMatchObject({
      adapterCode: "supervisor_identity_invalid",
    });
    await expect(system.usage("18446744073709551616")).rejects.toMatchObject({
      adapterCode: "supervisor_identity_invalid",
    });
    await expect(system.removeService({ id: system.id, hostUid: 502 })).rejects.toMatchObject({
      adapterCode: "supervisor_identity_invalid",
    });
    system.dispose();
  });
  it("keeps unacknowledged bootout distinct from service absence", async () => {
    const system = await createMacNativeSystem();
    mock.run.mockRejectedValue(
      Object.assign(new Error("unavailable"), { code: 113, stdout: "", stderr: "diagnostic" }),
    );
    expect(await system.removeService({ id: system.id, hostUid: 501 })).toBe(false);
    await expect(system.bootstrap()).rejects.toMatchObject({
      adapterCode: "supervisor_bootstrap_failed",
    });
    system.dispose();
  });
  it.each(["wrong-kind", "foreign-uid", "failed-query", "spawn-error"])(
    "rejects unverified socket peer credentials: %s",
    async (condition) => {
      const system = await createMacNativeSystem();
      mock.spawn.mockImplementation((file: string) => {
        if (condition === "spawn-error")
          throw Object.assign(new Error("descriptor closed"), { code: "EBADF" });
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          const identity = nativeIdentity(file, 200);
          if (condition === "foreign-uid") identity.uid = 502;
          child.stdout.write(
            JSON.stringify({ kind: condition === "wrong-kind" ? "identity" : "peer", identity }),
          );
          child.emit("close", condition === "failed-query" ? 1 : 0);
        });
        return child;
      });
      await expect(system.peer(new Socket())).rejects.toMatchObject({
        adapterCode: "supervisor_peer_unverified",
      });
      system.dispose();
    },
  );
  it("restricts cleanup/service labels to UUID-derived paths", () => {
    expect(() => macHostPaths("../foreign", 501)).toThrow();
    expect(() => macHostPaths(randomUUID(), -1)).toThrow();
    expect(() => macServicePlist('"><string>/bin/sh', 501)).toThrow();
  });
});
