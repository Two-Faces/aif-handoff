import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  macHostPaths,
  type MacNativeSystem,
  type MacFrame,
  type NativeMacIdentity,
} from "../supervision/macosSystem.js";
import {
  launchMacSupervisedProcess,
  recoverMacSupervisedProcess,
} from "../supervision/macosSupervisor.js";
import {
  macProcessHostIdentitySchema,
  type MacProcessHostIdentity,
  type ProcessHostIdentity,
} from "@aif/shared";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../supervision/macosSystem.js", async (original) => ({
  ...(await original<typeof import("../supervision/macosSystem.js")>()),
  createMacNativeSystem: factory,
}));
const clients: Socket[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  factory.mockReset();
});
function fixture() {
  const id = randomUUID(),
    paths = macHostPaths(id, 501);
  paths.socket =
    process.platform === "win32" ? "\\\\.\\pipe\\aif-mac-test-" + id : "/tmp/aif-mac-test-" + id;
  const host: NativeMacIdentity = {
    pid: 100,
    birth: "10000",
    uniqueId: "9007199254740993",
    uid: 501,
    pidVersion: 7,
    coalitionId: "50",
    image: paths.executable,
    stopped: false,
  };
  const child: NativeMacIdentity = {
    ...host,
    pid: 101,
    birth: "11000",
    uniqueId: "9007199254740994",
    pidVersion: 8,
    image: "/usr/bin/node",
    stopped: true,
  };
  let hostAlive = true,
    childAlive = false,
    launched = false;
  const received: MacFrame[] = [];
  const context = {
    hello: {} as MacFrame,
    prepared: { kind: "prepared", identity: child } as MacFrame,
    client: undefined as Socket | undefined,
    onCommand: undefined as ((frame: MacFrame) => void) | undefined,
    initialActive: "1",
    finish(reason = "completed", exitCode = 0) {
      context.client!.write(
        JSON.stringify({ kind: "stopped", reason, exitCode, terminatedProcesses: 1 }) + "\n",
      );
      hostAlive = false;
      childAlive = false;
      context.client!.end();
    },
    die() {
      hostAlive = false;
      context.client!.destroy();
    },
    setHostAlive(value: boolean) {
      hostAlive = value;
    },
  };
  const system: MacNativeSystem = {
    id,
    paths,
    uid: 501,
    bootSessionId: randomUUID(),
    parentCoalitionId: "40",
    bootstrap: vi.fn(async () => {
      await new Promise<void>((resolve, reject) => {
        const client = connect(paths.socket);
        clients.push(client);
        context.client = client;
        client.once("error", reject);
        let buffer = "";
        client.on("data", (bytes) => {
          buffer += bytes.toString();
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const f = JSON.parse(buffer.slice(0, newline)) as MacFrame;
            buffer = buffer.slice(newline + 1);
            received.push(f);
            context.onCommand?.(f);
            if (f.kind === "launch") {
              launched = true;
              childAlive = true;
              client.write(JSON.stringify(context.prepared) + "\n");
            } else if (f.kind === "start") {
              child.stopped = false;
              client.write('{"kind":"started"}\n');
            } else if (f.kind === "stop") context.finish("cancelled", 137);
            else if (f.kind === "input")
              client.write(
                JSON.stringify({ kind: "output", stream: "stdout", bytes: f.bytes }) + "\n",
              );
            else if (f.kind === "endInput") context.finish();
          }
        });
        client.once("connect", () => {
          client.write(JSON.stringify(context.hello) + "\n");
          resolve();
        });
      });
    }),
    peer: vi.fn(async () => ({ ...host })),
    inspect: vi.fn(async (pid) =>
      pid === host.pid
        ? hostAlive
          ? { ...host }
          : null
        : pid === child.pid && childAlive
          ? { ...child }
          : null,
    ),
    usage: vi.fn(async () =>
      !hostAlive && !childAlive
        ? { absent: true as const }
        : {
            kind: "usage" as const,
            started: launched ? "4" : "2",
            exited: launched ? "2" : "1",
            active: launched ? "2" : context.initialActive,
          },
    ),
    recover: vi.fn(async () => {
      hostAlive = false;
      childAlive = false;
    }),
    removeService: vi.fn(async () => true),
    removeFiles: vi.fn(),
    dispose: vi.fn(),
  };
  context.hello = {
    kind: "hello",
    id,
    bootSessionId: system.bootSessionId,
    identity: host,
    started: "2",
    exited: "1",
  };
  factory.mockResolvedValue(system);
  const input = {
    executable: "/usr/bin/node",
    args: ["a b", 'x"y', "$(literal)", "Привет"],
    cwd: "/tmp/task",
    environment: { PATH: "/usr/bin", Path: "/different" },
    onIdentity: vi.fn(async (_id: ProcessHostIdentity): Promise<void> => undefined),
    onPrepared: vi.fn(async (): Promise<void> => undefined),
  };
  return { ...context, context, system, input, received, host, child };
}
async function until(condition: () => boolean) {
  for (let n = 0; n < 100; ++n) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Protocol fixture did not advance");
}
function savedHost(f: ReturnType<typeof fixture>) {
  return macProcessHostIdentitySchema.parse(f.input.onIdentity.mock.calls[0][0]);
}
describe("macOS supervisor host protocol (portable simulated native peer)", () => {
  it("waits for both durable barriers and preserves literal argv, input and separate target output", async () => {
    const f = fixture(),
      output: string[] = [];
    let releaseIdentity!: () => void, releasePrepared!: () => void;
    f.input.onIdentity.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseIdentity = resolve;
        }),
    );
    f.input.onPrepared.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePrepared = resolve;
        }),
    );
    const launch = launchMacSupervisedProcess({
      ...f.input,
      onOutput: (_stream, bytes) => output.push(bytes.toString()),
    });
    await until(() => Boolean(releaseIdentity));
    expect(f.received).toEqual([]);
    releaseIdentity();
    await until(() => Boolean(releasePrepared));
    expect(f.received.map((x) => x.kind)).toEqual(["launch"]);
    expect(f.received[0]).toMatchObject({ args: f.input.args, environment: f.input.environment });
    releasePrepared();
    const child = await launch;
    expect(child.identity).toMatchObject({
      mechanism: "macos_coalition_v1",
      uniqueId: f.child.uniqueId,
    });
    child.write(Buffer.from('{"kind":"stopped","activeProcesses":0}'));
    await until(() => output.length === 1);
    expect(output).toEqual(['{"kind":"stopped","activeProcesses":0}']);
    child.endInput();
    child.endInput();
    expect(() => child.write(Buffer.from("after EOF"))).toThrow();
    const evidence = await child.completed;
    expect(evidence).toMatchObject({ reason: "completed", activeProcesses: 0, exitCode: 0 });
    expect(f.system.dispose).toHaveBeenCalledOnce();
    expect(await child.stop()).toEqual(evidence);
    expect(() => child.write(Buffer.from("late"))).toThrow();
  });
  it("does not resume a suspended process when persistence fails; recovery retains the original binding", async () => {
    const f = fixture();
    f.input.onPrepared.mockRejectedValue(new Error("storage unavailable"));
    await expect(launchMacSupervisedProcess(f.input)).rejects.toThrow("storage unavailable");
    expect(f.received.map((x) => x.kind)).toEqual(["launch"]);
    const identity = savedHost(f);
    expect(await recoverMacSupervisedProcess(identity)).toMatchObject({
      identity,
      reason: "recovered",
    });
    expect(f.system.recover).toHaveBeenCalledWith(identity);
    expect(f.system.removeFiles).toHaveBeenCalledWith(identity.id);
  });
  it("keeps host death uncertain until independent recovery verifies emptiness", async () => {
    const f = fixture(),
      child = await launchMacSupervisedProcess(f.input);
    f.context.die();
    await expect(child.completed).rejects.toMatchObject({ adapterCode: "supervisor_lost" });
    expect(f.system.removeFiles).not.toHaveBeenCalled();
    const host = savedHost(f);
    expect(await recoverMacSupervisedProcess(host)).toMatchObject({
      reason: "recovered",
      activeProcesses: 0,
    });
    expect(await recoverMacSupervisedProcess(host)).toMatchObject({ reason: "recovered" });
  });
  it("bounds finalization even when persistence remains pending after the native channel closes", async () => {
    const f = fixture(),
      abort = new AbortController();
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.input.onPrepared.mockImplementation(() => {
      entered();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const launch = launchMacSupervisedProcess({ ...f.input, signal: abort.signal });
    const rejected = expect(launch).rejects.toMatchObject({
      adapterCode: "supervisor_stop_timeout",
    });
    await preparing;
    const closed = new Promise<void>((resolve) => f.context.client!.once("close", () => resolve()));
    abort.abort();
    await closed;
    await vi.advanceTimersByTimeAsync(30001);
    await rejected;
    release();
    expect(f.received.some((frame) => frame.kind === "start")).toBe(false);
    expect(f.system.dispose).not.toHaveBeenCalled();
  });
  it("aborts through the control channel while the target is not reading stdin", async () => {
    const f = fixture(),
      abort = new AbortController();
    const child = await launchMacSupervisedProcess({ ...f.input, signal: abort.signal });
    child.write(Buffer.alloc(65536, 65));
    abort.abort();
    expect(await child.completed).toMatchObject({ reason: "cancelled", exitCode: 137 });
    expect(f.received.map((x) => x.kind)).toContain("stop");
  });
  it("requires independent empty accounting even after a claimed stopped frame", async () => {
    const f = fixture(),
      child = await launchMacSupervisedProcess(f.input);
    vi.mocked(f.system.usage).mockRejectedValue(new Error("native accounting unavailable"));
    f.context.finish();
    await expect(child.completed).rejects.toThrow("native accounting unavailable");
    expect(f.system.dispose).not.toHaveBeenCalled();
  });
  it("does not convert a reused host PID into an absent process", async () => {
    const f = fixture(),
      child = await launchMacSupervisedProcess(f.input);
    vi.mocked(f.system.inspect).mockResolvedValue({ ...f.host, uniqueId: "999" });
    f.context.finish();
    await expect(child.completed).rejects.toMatchObject({
      adapterCode: "supervisor_identity_changed",
    });
    expect(f.system.dispose).not.toHaveBeenCalled();
  });
  it.each(["uid", "boot", "coalition", "image", "count", "malformed", "peer"] as const)(
    "rejects a substituted host %s before allowing a child",
    async (field) => {
      const f = fixture();
      if (field === "uid") f.host.uid = 502;
      if (field === "boot") f.context.hello.bootSessionId = randomUUID();
      if (field === "coalition") f.host.coalitionId = "40";
      if (field === "image") f.host.image = "/foreign/helper";
      if (field === "count") f.context.initialActive = "2";
      if (field === "malformed") f.context.hello.identity = null;
      if (field === "peer")
        vi.mocked(f.system.peer).mockResolvedValue({ ...f.host, pid: 999, uniqueId: "999" });
      await expect(launchMacSupervisedProcess(f.input)).rejects.toMatchObject({
        category: "transport",
      });
      expect(f.received).toEqual([]);
      expect(f.input.onIdentity).not.toHaveBeenCalled();
    },
  );
  it.each(["running", "foreign", "swapped"] as const)(
    "rejects an unverified prepared child: %s",
    async (field) => {
      const f = fixture();
      if (field === "running") f.child.stopped = false;
      if (field === "foreign") f.child.coalitionId = "99";
      if (field === "swapped") f.context.prepared.identity = { ...f.child, uniqueId: "999" };
      await expect(launchMacSupervisedProcess(f.input)).rejects.toMatchObject({
        adapterCode: "supervisor_protocol_invalid",
      });
      expect(f.input.onPrepared).not.toHaveBeenCalled();
      expect(f.received.some((x) => x.kind === "start")).toBe(false);
    },
  );
  it.each(["boot", "uid", "shared"] as const)(
    "rejects incompatible recovery scope: %s",
    async (field) => {
      const f = fixture(),
        child = await launchMacSupervisedProcess(f.input);
      await child.stop();
      const saved = savedHost(f);
      const changed = { ...saved };
      if (field === "boot") changed.bootSessionId = randomUUID();
      if (field === "uid") changed.hostUid = 502;
      if (field === "shared") changed.coalitionId = "40";
      await expect(recoverMacSupervisedProcess(changed)).rejects.toMatchObject({
        adapterCode: "supervisor_identity_invalid",
      });
      expect(f.system.recover).not.toHaveBeenCalled();
    },
  );
  it("distinguishes a lost bootout ACK from an unverified service removal", async () => {
    const f = fixture(),
      child = await launchMacSupervisedProcess(f.input);
    await child.stop();
    const saved = savedHost(f);
    vi.mocked(f.system.removeService).mockResolvedValue(false);
    expect(await recoverMacSupervisedProcess(saved)).toMatchObject({ reason: "recovered" });
    vi.mocked(f.system.usage).mockResolvedValue({
      kind: "usage",
      started: "4",
      exited: "4",
      active: "0",
    });
    await expect(recoverMacSupervisedProcess(saved)).rejects.toMatchObject({
      adapterCode: "supervisor_service_removal_unverified",
    });
  });
  it("rejects invalid inputs before creating a native host", async () => {
    const f = fixture();
    for (const patch of [
      { executable: "node" },
      { cwd: "relative" },
      { args: ["bad\0"] },
      { environment: { "BAD=KEY": "x" } },
      { args: ["x".repeat(24001)] },
    ])
      await expect(launchMacSupervisedProcess({ ...f.input, ...patch })).rejects.toMatchObject({
        adapterCode: "supervisor_input_invalid",
      });
    await expect(
      launchMacSupervisedProcess({ ...f.input, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ adapterCode: "supervisor_cancelled" });
    expect(factory).not.toHaveBeenCalled();
    await expect(recoverMacSupervisedProcess({} as MacProcessHostIdentity)).rejects.toMatchObject({
      adapterCode: "supervisor_identity_invalid",
    });
  });
  it("rejects malformed control/output and error frames without a successful receipt", async () => {
    const f = fixture(),
      child = await launchMacSupervisedProcess(f.input);
    f.context.client!.write('{"kind":"output","stream":"stdout","bytes":"invalid!"}\n');
    await expect(child.completed).rejects.toMatchObject({
      adapterCode: "supervisor_protocol_invalid",
    });
    expect(f.system.dispose).not.toHaveBeenCalled();
  });
});
