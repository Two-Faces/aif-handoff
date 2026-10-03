import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { promisify } from "node:util";
import {
  nativeMacProcessIdentitySchema,
  nativeMacUsageSchema,
  processBootSessionIdSchema,
  type NativeMacProcessIdentity,
  type NativeMacUsage,
  type MacProcessHostIdentity,
} from "@aif/shared";
import { RuntimeExecutionError } from "../errors.js";
import { macosNativeSource } from "./macosNativeSource.js";

export type MacFrame = Record<string, unknown>;
const execute = promisify(execFile);
export const nativeMacIdentitySchema = nativeMacProcessIdentitySchema;
export type NativeMacIdentity = NativeMacProcessIdentity;
export type MacUsage = NativeMacUsage | { absent: true };
const validUint64 = (value: string) =>
  /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;

export function macFailure(code: string, cause?: unknown) {
  return new RuntimeExecutionError(
    "Native macOS process supervision could not be verified.",
    cause,
    "transport",
    { adapterCode: code },
  );
}
export function macFrame(value: unknown): MacFrame {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw macFailure("supervisor_protocol_invalid");
  return value as MacFrame;
}
function parseFrame(text: string): MacFrame {
  try {
    return macFrame(JSON.parse(text));
  } catch {
    throw macFailure("supervisor_protocol_invalid");
  }
}
function isNativeError(frame: MacFrame, stage: string, code: number) {
  return frame.kind === "error" && frame.stage === stage && frame.nativeCode === code;
}
function successful(frame: MacFrame): MacFrame {
  if (frame.kind === "error")
    throw macFailure("supervisor_native_failed", {
      nativeStage: frame.stage,
      nativeCode: frame.nativeCode,
    });
  return frame;
}
export function macHostPaths(id: string, uid: number) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    uid > 0xffffffff
  )
    throw macFailure("supervisor_identity_invalid");
  const root = "/private/tmp/aif-supervisor-" + id;
  const label = "com.aif.handoff.supervisor-" + id;
  return {
    root,
    executable: root + "/host",
    socket: root + "/control.sock",
    plist: root + "/service.plist",
    label,
    target: "gui/" + uid + "/" + label,
    domain: "gui/" + uid,
  };
}
export function macServicePlist(id: string, uid: number) {
  const p = macHostPaths(id, uid);
  // Every variable in this plist is a validated UUID/integer-derived path.
  // env -i keeps task/shell DYLD/NODE/etc. overrides out of the trusted host.
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
    "<key>Label</key><string>" +
    p.label +
    "</string><key>ProgramArguments</key><array>" +
    "<string>/usr/bin/env</string><string>-i</string><string>PATH=/usr/bin:/bin:/usr/sbin:/sbin</string>" +
    "<string>" +
    p.executable +
    "</string><string>host</string><string>" +
    p.root +
    "</string></array>" +
    "<key>WorkingDirectory</key><string>" +
    p.root +
    "</string><key>RunAtLoad</key><true/>" +
    "<key>KeepAlive</key><false/><key>AbandonProcessGroup</key><true/>" +
    "<key>ProcessType</key><string>Background</string>" +
    "<key>StandardOutPath</key><string>" +
    p.root +
    "/host.out</string>" +
    "<key>StandardErrorPath</key><string>" +
    p.root +
    "/host.err</string></dict></plist>\n"
  );
}
function ownedDirectory(root: string, id: string, uid: number): boolean {
  if (root !== macHostPaths(id, uid).root) throw macFailure("supervisor_identity_invalid");
  if (!existsSync(root)) return false;
  const info = lstatSync(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o077) !== 0 ||
    realpathSync(root) !== root
  )
    throw macFailure("supervisor_directory_changed");
  return true;
}
export interface MacNativeSystem {
  id: string;
  uid: number;
  bootSessionId: string;
  parentCoalitionId: string;
  paths: ReturnType<typeof macHostPaths>;
  bootstrap(): Promise<void>;
  peer(socket: Socket): Promise<NativeMacIdentity>;
  inspect(pid: number): Promise<NativeMacIdentity | null>;
  usage(coalitionId: string): Promise<MacUsage>;
  recover(identity: MacProcessHostIdentity): Promise<void>;
  removeService(identity: Pick<MacProcessHostIdentity, "id" | "hostUid">): Promise<boolean>;
  removeFiles(id: string): void;
  dispose(): void;
}

/** Compiles only bundled source, never prompts or task data. No child task is
 * created here. The returned host must wait for both durable launch barriers. */
export async function createMacNativeSystem(): Promise<MacNativeSystem> {
  if (process.platform !== "darwin" || typeof process.getuid !== "function")
    throw macFailure("supervisor_unsupported");
  const uid = process.getuid(),
    id = randomUUID(),
    paths = macHostPaths(id, uid);
  if (realpathSync("/private/tmp") !== "/private/tmp") throw macFailure("supervisor_unsupported");
  mkdirSync(paths.root, { mode: 0o700 });
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir(),
    TMPDIR: paths.root,
    LC_ALL: "C",
  };
  let binaryHash: string | undefined;
  function verifyBinary() {
    if (!ownedDirectory(paths.root, id, uid)) throw macFailure("supervisor_directory_changed");
    const info = lstatSync(paths.executable);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      createHash("sha256").update(readFileSync(paths.executable)).digest("hex") !== binaryHash
    )
      throw macFailure("supervisor_binary_changed");
  }
  async function command(file: string, args: string[], timeout = 10000) {
    try {
      const result = await execute(file, args, {
        encoding: "utf8",
        env: environment,
        cwd: paths.root,
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr.slice(0, 8000) };
    } catch (error) {
      const row = macFrame(error);
      return {
        code: typeof row.code === "number" ? row.code : null,
        stdout: typeof row.stdout === "string" ? row.stdout : "",
        stderr: typeof row.stderr === "string" ? row.stderr.slice(0, 8000) : "",
      };
    }
  }
  async function native(args: string[], timeout = 10000): Promise<MacFrame> {
    verifyBinary();
    const result = await command(paths.executable, args, timeout);
    let frame: MacFrame;
    try {
      frame = parseFrame(result.stdout);
    } catch {
      throw macFailure("supervisor_protocol_invalid", {
        nativeExit: result.code,
        diagnostics: result.stderr,
      });
    }
    if (result.code !== (frame.kind === "error" ? 1 : 0))
      throw macFailure("supervisor_native_lost");
    return frame;
  }
  function removeFiles(removeId: string) {
    const remove = macHostPaths(removeId, uid);
    if (ownedDirectory(remove.root, removeId, uid)) rmSync(remove.root, { recursive: true });
  }
  try {
    const source = posix.join(paths.root, "host.m");
    writeFileSync(source, macosNativeSource, { mode: 0o600, flag: "wx" });
    const [compiler, sdk] = await Promise.all([
      command("/usr/bin/xcrun", ["--find", "clang"]),
      command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]),
    ]);
    if (
      compiler.code !== 0 ||
      sdk.code !== 0 ||
      !compiler.stdout.trim().startsWith("/") ||
      !sdk.stdout.trim().startsWith("/")
    )
      throw macFailure("supervisor_toolchain_unavailable");
    const result = await command(
      compiler.stdout.trim(),
      [
        "-x",
        "objective-c",
        "-fobjc-arc",
        "-std=gnu11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-isysroot",
        sdk.stdout.trim(),
        source,
        "-framework",
        "Foundation",
        "-lproc",
        "-o",
        paths.executable,
      ],
      30000,
    );
    if (result.code !== 0)
      throw macFailure("supervisor_compile_failed", { diagnostics: result.stderr });
    chmodSync(paths.executable, 0o700);
    binaryHash = createHash("sha256").update(readFileSync(paths.executable)).digest("hex");
    const capability = successful(await native(["capabilities"]));
    const boot = processBootSessionIdSchema.safeParse(capability.bootSessionId);
    const parent = nativeMacIdentitySchema.safeParse(capability.identity);
    if (
      capability.kind !== "capabilities" ||
      capability.uid !== uid ||
      !boot.success ||
      !parent.success ||
      parent.data.uid !== uid
    )
      throw macFailure("supervisor_protocol_invalid", {
        phase: "capabilities",
        kindMatches: capability.kind === "capabilities",
        uidMatches: capability.uid === uid,
        identityUidMatches: parent.success && parent.data.uid === uid,
        bootIssues: boot.success ? [] : boot.error.issues.map(({ code, path }) => ({ code, path })),
        identityIssues: parent.success
          ? []
          : parent.error.issues.map(({ code, path }) => ({ code, path })),
      });
    return {
      id,
      uid,
      bootSessionId: boot.data,
      parentCoalitionId: parent.data.coalitionId,
      paths,
      async bootstrap() {
        verifyBinary();
        writeFileSync(paths.plist, macServicePlist(id, uid), { mode: 0o600, flag: "wx" });
        const started = await command("/bin/launchctl", ["bootstrap", paths.domain, paths.plist]);
        if (started.code !== 0) throw macFailure("supervisor_bootstrap_failed");
      },
      async peer(socket) {
        verifyBinary();
        return new Promise<NativeMacIdentity>((resolve, reject) => {
          let child: ChildProcess;
          try {
            child = spawn(paths.executable, ["peer"], {
              cwd: paths.root,
              env: environment,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe", socket],
            });
          } catch (error) {
            reject(macFailure("supervisor_peer_unverified", error));
            return;
          }
          let settled = false,
            output = "",
            diagnostics = "";
          const timer = setTimeout(() => fail(macFailure("supervisor_peer_unverified")), 10000);
          function fail(error: unknown) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // This is only the fresh metadata query, never a target PID or a
            // substitute for native stop evidence.
            try {
              child.kill();
            } catch {
              /* Query failure already rejects. */
            }
            reject(error);
          }
          child.once("error", (error) => fail(macFailure("supervisor_peer_unverified", error)));
          if (!child.stdout || !child.stderr) {
            fail(macFailure("supervisor_peer_unverified"));
            return;
          }
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (bytes: string) => {
            output += bytes;
            if (output.length > 1048576) fail(macFailure("supervisor_protocol_invalid"));
          });
          child.stderr.on("data", (bytes: string) => {
            diagnostics = (diagnostics + bytes).slice(0, 8000);
          });
          child.once("close", (code) => {
            if (settled) return;
            try {
              const result = successful(parseFrame(output));
              const parsed = nativeMacIdentitySchema.safeParse(result.identity);
              if (
                code !== 0 ||
                result.kind !== "peer" ||
                !parsed.success ||
                parsed.data.uid !== uid
              )
                throw macFailure("supervisor_peer_unverified", { nativeExit: code, diagnostics });
              settled = true;
              clearTimeout(timer);
              resolve(parsed.data);
            } catch (error) {
              fail(error);
            }
          });
        });
      },
      async inspect(pid) {
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)
          throw macFailure("supervisor_identity_invalid");
        const result = await native(["identity", String(pid)]);
        if (isNativeError(result, "inspect", 3)) return null;
        successful(result);
        const parsed = nativeMacIdentitySchema.safeParse(result.identity);
        if (result.kind !== "identity" || !parsed.success)
          throw macFailure("supervisor_protocol_invalid");
        return parsed.data;
      },
      async usage(coalitionId) {
        if (!validUint64(coalitionId) || coalitionId === "0")
          throw macFailure("supervisor_identity_invalid");
        const result = await native(["usage", coalitionId]);
        if (isNativeError(result, "usage", 3)) return { absent: true };
        successful(result);
        const parsed = nativeMacUsageSchema.safeParse(result);
        if (!parsed.success) throw macFailure("supervisor_protocol_invalid");
        return parsed.data;
      },
      async recover(identity) {
        if (
          identity.hostUid !== uid ||
          identity.bootSessionId !== boot.data ||
          identity.coalitionId === parent.data.coalitionId
        )
          throw macFailure("supervisor_identity_invalid");
        const result = successful(await native(["recover", JSON.stringify(identity)], 30000));
        if (result.kind !== "recovered" || result.activeProcesses !== 0)
          throw macFailure("supervisor_stop_unproven");
      },
      async removeService(identity) {
        if (identity.hostUid !== uid) throw macFailure("supervisor_identity_invalid");
        const result = await command("/bin/launchctl", [
          "bootout",
          macHostPaths(identity.id, uid).target,
        ]);
        return result.code === 0;
      },
      removeFiles,
      dispose() {
        removeFiles(id);
      },
    };
  } catch (error) {
    removeFiles(id);
    throw error;
  }
}
