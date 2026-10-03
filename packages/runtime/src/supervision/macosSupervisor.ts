import { createServer, type Socket } from "node:net";
import { AsyncResource } from "node:async_hooks";
import {
  macProcessHostIdentitySchema,
  macPreparedProcessIdentitySchema,
  processHostIdentity,
  type MacProcessHostIdentity,
  type MacPreparedProcessIdentity,
  type ProcessStopEvidence,
} from "@aif/shared";
import type { SupervisedProcess, SupervisedProcessInput } from "./processSupervisor.js";
import {
  createMacNativeSystem,
  macFailure,
  macFrame,
  nativeMacIdentitySchema,
  type MacFrame,
  type MacNativeSystem,
  type NativeMacIdentity,
} from "./macosSystem.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function request(input: SupervisedProcessInput) {
  const text = (x: unknown): x is string =>
    typeof x === "string" && !x.includes("\0") && x.length < 32768;
  if (
    !text(input.executable) ||
    !input.executable.startsWith("/") ||
    !text(input.cwd) ||
    !input.cwd.startsWith("/") ||
    !Array.isArray(input.args) ||
    !input.args.every(text) ||
    input.args.reduce((n, arg) => n + arg.length, 0) > 24000
  )
    throw macFailure("supervisor_input_invalid");
  const environment = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(input.environment ?? process.env)) {
    if (value === undefined) continue;
    if (!key || !text(key) || key.includes("=") || !text(value))
      throw macFailure("supervisor_input_invalid");
    environment[key] = value;
  }
  const result = {
    kind: "launch",
    executable: input.executable,
    args: [...input.args],
    cwd: input.cwd,
    environment,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024)
    throw macFailure("supervisor_input_invalid");
  return result;
}
function sameProcess(a: NativeMacIdentity, b: NativeMacIdentity | null) {
  return (
    b !== null &&
    a.pid === b.pid &&
    a.birth === b.birth &&
    a.uid === b.uid &&
    a.uniqueId === b.uniqueId &&
    a.pidVersion === b.pidVersion &&
    a.coalitionId === b.coalitionId &&
    a.image === b.image &&
    a.stopped === b.stopped
  );
}
async function empty(system: MacNativeSystem, identity: MacProcessHostIdentity) {
  const deadline = Date.now() + 10000;
  while (true) {
    const state = await system.usage(identity.coalitionId);
    const host = await system.inspect(identity.hostPid);
    if (
      host &&
      (host.uniqueId !== identity.hostUniqueId ||
        host.birth !== identity.hostBirth ||
        host.pidVersion !== identity.hostPidVersion ||
        host.uid !== identity.hostUid ||
        host.coalitionId !== identity.coalitionId)
    )
      throw macFailure("supervisor_identity_changed");
    if (!host && ("absent" in state || state.active === "0")) return;
    if (Date.now() >= deadline) throw macFailure("supervisor_stop_unproven");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Internal native primitive. A one-shot launchd host never persists target
 * arguments, cannot accept a second controller or restart a task autonomously. */
export async function launchMacSupervisedProcess(
  input: SupervisedProcessInput,
): Promise<SupervisedProcess> {
  const launch = request(input);
  if (input.signal?.aborted) throw macFailure("supervisor_cancelled");
  const system = await createMacNativeSystem();
  if (input.signal?.aborted) {
    system.dispose();
    throw macFailure("supervisor_cancelled");
  }
  const ready = deferred<SupervisedProcess>(),
    completed = deferred<ProcessStopEvidence>();
  const server = createServer();
  server.maxConnections = 1;
  let socket: Socket | undefined,
    connected = false,
    failed: unknown,
    ended = false;
  let identity: MacProcessHostIdentity | undefined,
    prepared: MacPreparedProcessIdentity | undefined;
  let launched = false,
    started = false,
    stopping = false,
    inputClosed = false,
    stopped: ProcessStopEvidence | undefined;
  let buffer = "",
    queuedBytes = 0,
    queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function send(frame: MacFrame) {
    if (failed || ended || !socket || socket.destroyed)
      throw failed ?? macFailure("supervisor_lost");
    if (socket.writableLength > 4 * 1024 * 1024) throw macFailure("supervisor_input_overflow");
    socket.write(JSON.stringify(frame) + "\n");
  }
  function closeChannel() {
    socket?.destroy();
    server.close();
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
  function fail(error: unknown) {
    if (failed) return;
    failed = error;
    ready.reject(error);
    completed.reject(error);
    closeChannel();
    if (!launched) {
      // No launch request was sent. Closing the one-shot channel prevents a
      // future target even if launchd's removal acknowledgement is unavailable.
      void system
        .removeService({ id: system.id, hostUid: system.uid })
        .then(() => system.dispose())
        .catch(() => undefined);
    }
    // Never synthesize stop evidence after losing the host. Its EOF handler
    // attempts cleanup; the journal still requires explicit native recovery.
  }
  function stop() {
    if (!stopping && !stopped && !failed) {
      stopping = true;
      if (launched) {
        clearTimeout(timer);
        timer = setTimeout(() => fail(macFailure("supervisor_stop_timeout")), 30000);
        try {
          send({ kind: "stop" });
        } catch (error) {
          fail(error);
        }
      }
    }
    return completed.promise;
  }
  function abort() {
    void stop();
  }
  async function frame(value: MacFrame) {
    if (failed) return;
    if (value.kind === "error")
      throw macFailure("supervisor_native_failed", {
        nativeStage: value.stage,
        nativeCode: value.nativeCode,
      });
    if (value.kind === "hello" && !identity) {
      const native = nativeMacIdentitySchema.safeParse(value.identity);
      if (
        !native.success ||
        value.id !== system.id ||
        value.bootSessionId !== system.bootSessionId ||
        native.data.uid !== system.uid ||
        native.data.image !== system.paths.executable ||
        native.data.stopped ||
        native.data.coalitionId === system.parentCoalitionId
      )
        throw macFailure("supervisor_protocol_invalid", {
          phase: "hello",
          observed: native.success ? native.data : null,
        });
      const n = native.data;
      if (!socket || !sameProcess(n, await system.peer(socket)))
        throw macFailure("supervisor_peer_mismatch");
      const accounting = await system.usage(n.coalitionId);
      if (
        "absent" in accounting ||
        accounting.active !== "1" ||
        accounting.started !== value.started ||
        accounting.exited !== value.exited ||
        !sameProcess(n, await system.inspect(n.pid))
      )
        throw macFailure("supervisor_host_not_isolated");
      identity = Object.freeze(
        macProcessHostIdentitySchema.parse({
          version: 1,
          mechanism: "macos_coalition_v1",
          id: system.id,
          serviceName: system.paths.label,
          hostPid: n.pid,
          hostBirth: n.birth,
          hostUid: n.uid,
          hostUniqueId: n.uniqueId,
          hostPidVersion: n.pidVersion,
          bootSessionId: system.bootSessionId,
          coalitionId: n.coalitionId,
        }),
      );
      await input.onIdentity(identity);
      if (stopping || input.signal?.aborted) throw macFailure("supervisor_cancelled");
      launched = true;
      send(launch);
    } else if (value.kind === "prepared" && identity && launched && !prepared) {
      const native = nativeMacIdentitySchema.safeParse(value.identity);
      if (
        !native.success ||
        !native.data.stopped ||
        native.data.uid !== identity.hostUid ||
        native.data.coalitionId !== identity.coalitionId ||
        native.data.pid === identity.hostPid ||
        native.data.uniqueId === identity.hostUniqueId ||
        !sameProcess(native.data, await system.inspect(native.data.pid))
      )
        throw macFailure("supervisor_protocol_invalid", {
          phase: "prepared",
          observed: native.success ? native.data : null,
        });
      const n = native.data;
      prepared = Object.freeze(
        macPreparedProcessIdentitySchema.parse({
          ...identity,
          pid: n.pid,
          birth: n.birth,
          uniqueId: n.uniqueId,
          pidVersion: n.pidVersion,
        }),
      );
      await input.onPrepared(prepared);
      if (!stopping && !input.signal?.aborted) send({ kind: "start" });
      else void stop();
    } else if (value.kind === "started" && prepared && !started) {
      started = true;
      clearTimeout(timer);
      ready.resolve({
        identity: prepared,
        completed: completed.promise,
        stop,
        write(bytes) {
          if (stopping || stopped || inputClosed || bytes.byteLength > 65536)
            throw macFailure("supervisor_input_invalid");
          send({ kind: "input", bytes: Buffer.from(bytes).toString("base64") });
        },
        endInput() {
          if (!stopping && !stopped && !inputClosed) {
            inputClosed = true;
            send({ kind: "endInput" });
          }
        },
      });
    } else if (value.kind === "output" && prepared && !stopped) {
      if (
        (value.stream !== "stdout" && value.stream !== "stderr") ||
        typeof value.bytes !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytes)
      )
        throw macFailure("supervisor_protocol_invalid");
      input.onOutput?.(value.stream, Buffer.from(value.bytes, "base64"));
    } else if (value.kind === "stopped" && prepared && !stopped) {
      if (
        !Number.isSafeInteger(value.exitCode) ||
        (value.exitCode as number) < 0 ||
        (value.exitCode as number) > 0xffffffff ||
        !Number.isSafeInteger(value.terminatedProcesses) ||
        (value.terminatedProcesses as number) < 0 ||
        (value.terminatedProcesses as number) > 0xffffffff ||
        (value.reason !== "completed" && value.reason !== "cancelled")
      )
        throw macFailure("supervisor_protocol_invalid");
      // This frame attests only to the host's completed loop. The caller below
      // separately verifies that the native coalition, including the host, is empty.
      stopped = {
        identity: prepared,
        activeProcesses: 0,
        reason: value.reason,
        exitCode: value.exitCode as number,
        terminatedProcesses: value.terminatedProcesses as number,
      };
    } else throw macFailure("supervisor_protocol_invalid");
  }
  // Accepted sockets have their own async resource. Restore the launch caller's
  // scope for persistence/output callbacks; the data layer still fences every write.
  const scopedFrame = AsyncResource.bind(frame);
  server.on("connection", (peer) => {
    if (connected) {
      peer.destroy();
      return;
    }
    connected = true;
    socket = peer;
    peer.setEncoding("utf8");
    peer.on("error", (error) => fail(macFailure("supervisor_channel_failed", error)));
    peer.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1048576) {
        fail(macFailure("supervisor_protocol_invalid"));
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const bytes = Buffer.byteLength(line);
        queuedBytes += bytes;
        if (queuedBytes > 4 * 1024 * 1024) {
          fail(macFailure("supervisor_output_overflow"));
          return;
        }
        queue = queue
          .then(async () => {
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              throw macFailure("supervisor_protocol_invalid");
            }
            await scopedFrame(macFrame(value));
          })
          .catch(fail)
          .finally(() => {
            queuedBytes -= bytes;
          });
      }
    });
    peer.on("close", () => {
      ended = true;
      clearTimeout(timer);
      server.close();
      if (failed) return;
      timer = setTimeout(() => fail(macFailure("supervisor_stop_timeout")), 30000);
      void queue
        .then(async () => {
          if (failed) return;
          if (!identity || !stopped || buffer.trim()) throw macFailure("supervisor_lost");
          await empty(system, identity);
          if (!(await system.removeService(identity)))
            throw macFailure("supervisor_service_removal_unverified");
          await empty(system, identity);
          system.dispose();
          completed.resolve(stopped);
          if (!started) ready.reject(macFailure("supervisor_cancelled"));
        })
        .catch(fail)
        .finally(() => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
        });
    });
  });
  server.on("error", (error) => fail(macFailure("supervisor_channel_failed", error)));
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(system.paths.socket, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    timer = setTimeout(() => fail(macFailure("supervisor_start_timeout")), 30000);
    await system.bootstrap();
    if (input.signal?.aborted) abort();
  } catch (error) {
    fail(error);
  }
  return ready.promise;
}

export async function recoverMacSupervisedProcess(
  value: MacProcessHostIdentity,
): Promise<ProcessStopEvidence> {
  const host = macProcessHostIdentitySchema.safeParse(value);
  let identity: MacProcessHostIdentity;
  if (host.success) identity = Object.freeze(host.data);
  else {
    const prepared = macPreparedProcessIdentitySchema.safeParse(value);
    if (!prepared.success) throw macFailure("supervisor_identity_invalid");
    identity = Object.freeze(
      macProcessHostIdentitySchema.parse(processHostIdentity(prepared.data)),
    );
  }
  const system = await createMacNativeSystem();
  try {
    if (
      system.uid !== identity.hostUid ||
      system.bootSessionId !== identity.bootSessionId ||
      system.parentCoalitionId === identity.coalitionId
    )
      throw macFailure("supervisor_identity_invalid");
    await system.recover(identity);
    await empty(system, identity);
    const removed = await system.removeService(identity);
    const state = await system.usage(identity.coalitionId);
    // Lost acknowledgement after bootout is recoverable only when the exact
    // same-boot coalition has actually been reaped. Other launchctl errors do
    // not establish service absence. No target request is saved on disk.
    if (!removed && !("absent" in state)) throw macFailure("supervisor_service_removal_unverified");
    await empty(system, identity);
    system.removeFiles(identity.id);
    return {
      identity,
      activeProcesses: 0,
      reason: "recovered",
      exitCode: null,
      terminatedProcesses: null,
    };
  } finally {
    system.dispose();
  }
}
