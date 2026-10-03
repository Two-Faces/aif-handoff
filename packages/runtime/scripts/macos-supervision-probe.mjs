import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessMacSupervisionProbe,
  assertMacProbeProcess,
  freshMacProbeCoalition,
  macProbePlist,
  macProbeService,
  parseMacProbeIdentity,
  parseMacProbeManifest,
  parseMacProbeUsage,
  sameMacProbeProcess,
} from "../src/supervision/macosProbe.ts";

const stageError = (code, details = {}) => Object.assign(new Error(code), { code, details });
function command(file, args, options = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync(file, args, {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
      }),
    };
  } catch (error) {
    return {
      status: Number.isInteger(error.status) ? error.status : null,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? "").slice(0, 8000),
      code: error.code ?? null,
      signal: error.signal ?? null,
    };
  }
}
function native(binary, args) {
  const result = command(binary, args);
  try {
    const value = JSON.parse(result.stdout);
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.ok !== "boolean" ||
      (value.ok && result.status !== 0) ||
      (!value.ok && result.status !== 1)
    )
      throw stageError("native_protocol");
    return value;
  } catch {
    throw stageError("native_protocol", result);
  }
}
function requireNative(binary, args, stage) {
  const result = native(binary, args);
  if (!result.ok) throw stageError(stage, result);
  return result;
}
const processArgs = (identity) => [
  String(identity.pid),
  identity.uniqueId,
  String(identity.pidVersion),
  identity.coalitionId,
];
function stillAlive(binary, identity) {
  const result = native(binary, ["inspect", String(identity.pid)]);
  if (!result.ok) {
    if (result.errno === 3) return false;
    throw stageError("identity_inspection_failed", result);
  }
  assertMacProbeProcess(identity, parseMacProbeIdentity(result));
  return true;
}
function signalOwned(binary, identity) {
  const result = native(binary, ["signal", ...processArgs(identity), "9"]);
  if (!result.ok && result.errno !== 3) throw stageError("audit_stop_failed", result);
  return result;
}
function usage(binary, coalitionId, allowAbsent = false) {
  const result = native(binary, ["usage", coalitionId]);
  if (!result.ok && allowAbsent && result.stage === "usage" && result.errno === 3)
    return { coalitionId, absent: true, errno: 3 };
  if (!result.ok) throw stageError("coalition_accounting_failed", result);
  return parseMacProbeUsage(result);
}
async function until(operation, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = operation();
    if (result) return result;
    if (Date.now() >= deadline) throw stageError("probe_timeout");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
function save(root, name, value) {
  const temp = join(root, `${name}.${randomUUID()}.tmp`),
    path = join(root, name);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(root, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function identityFile(root, name) {
  const path = join(root, name);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || statSync(path).size > 4096)
    throw stageError("fixture_identity_invalid");
  // The fixture writes to an exclusive file and fsyncs it. A read before its
  // first complete line is not yet an identity; never signal from partial JSON.
  const text = readFileSync(path, "utf8");
  if (!text.endsWith("\n")) return null;
  return parseMacProbeIdentity(JSON.parse(text));
}
function checkedRoot(root) {
  const parent = realpathSync(tmpdir()),
    resolved = realpathSync(root),
    delta = relative(parent, resolved);
  if (
    lstatSync(root).isSymbolicLink() ||
    !delta ||
    delta.startsWith("..") ||
    delta.includes(sep) ||
    !/^aif-macos-probe-[A-Za-z0-9]+$/.test(delta) ||
    lstatSync(resolved).uid !== process.getuid() ||
    (lstatSync(resolved).mode & 0o077) !== 0
  )
    throw stageError("cleanup_path_rejected");
  return resolved;
}
async function cleanup(root, manifest, binary) {
  checkedRoot(root);
  manifest = parseMacProbeManifest(manifest, process.getuid());
  if (manifest.driverPid !== process.pid) {
    let active = true;
    try {
      process.kill(manifest.driverPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") active = false;
      else throw stageError("probe_driver_unverified");
    }
    if (active) throw stageError("probe_driver_active");
  }
  const service = macProbeService(process.getuid(), manifest.id);
  if (manifest.uid !== process.getuid() || manifest.target !== service.target)
    throw stageError("cleanup_identity_rejected");
  if (!manifest.nativeStarted && !manifest.bootstrapped) {
    rmSync(root, { recursive: true });
    return true;
  }
  const binaryInfo = lstatSync(binary);
  if (
    !binaryInfo.isFile() ||
    binaryInfo.isSymbolicLink() ||
    binaryInfo.uid !== process.getuid() ||
    createHash("sha256").update(readFileSync(binary)).digest("hex") !== manifest.binaryHash
  )
    throw stageError("cleanup_binary_changed");
  writeFileSync(join(root, "stop"), "stop", { mode: 0o600 });
  if (manifest.bootstrapped && !manifest.serviceRemoved) {
    const result = command("/bin/launchctl", ["bootout", service.target]);
    if (result.status !== 0) throw stageError("service_removal_unverified", result);
    manifest.serviceRemoved = true;
    save(root, "manifest.json", manifest);
  }
  const identities = ["root.json", "grandchild.json", "control.json"]
    .map((name) => identityFile(root, name))
    .filter(Boolean);
  for (const identity of identities) signalOwned(binary, identity);
  await until(() => identities.every((identity) => !stillAlive(binary, identity)));
  if (manifest.coalitionId) {
    await until(() => {
      const current = usage(binary, manifest.coalitionId, true);
      return "absent" in current || current.active === "0";
    });
  } else if (existsSync(join(root, "go"))) throw stageError("cleanup_coalition_unknown");
  // Only the nonce-specific launchd service and this checked temporary directory
  // are removed. No task DB, user project, runtime profile or auth state is read.
  rmSync(root, { recursive: true });
  return true;
}

async function probe() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aif-macos-probe-")));
  chmodSync(root, 0o700);
  const id = randomUUID(),
    service = macProbeService(process.getuid(), id);
  const binary = join(root, "probe"),
    plist = join(root, "service.plist");
  const manifest = {
    version: 1,
    id,
    uid: process.getuid(),
    driverPid: process.pid,
    target: service.target,
    bootstrapped: false,
    serviceRemoved: false,
    coalitionId: null,
    nativeStarted: false,
    binaryHash: null,
  };
  const report = {
    version: 1,
    platform: "darwin",
    architecture: arch(),
    kernel: release(),
    status: "blocked",
    grantsExecution: false,
    cleanupVerified: false,
    stages: {},
    blockers: [],
  };
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    writeFileSync(join(root, "stop"), "stop", { mode: 0o600 });
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    save(root, "manifest.json", manifest);
    const found = command("/usr/bin/xcrun", ["--find", "clang"]);
    if (found.status !== 0 || !found.stdout.trim().startsWith("/"))
      throw stageError("compiler_unavailable", found);
    report.compiler = found.stdout.trim();
    const sdk = command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
    if (sdk.status !== 0 || !sdk.stdout.trim().startsWith("/"))
      throw stageError("sdk_unavailable", sdk);
    report.sdk = sdk.stdout.trim();
    const source = join(
      dirname(fileURLToPath(import.meta.url)),
      "native",
      "macos-supervision-probe.c",
    );
    const compiled = command(report.compiler, [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-isysroot",
      report.sdk,
      source,
      "-lproc",
      "-o",
      binary,
    ]);
    if (compiled.status !== 0) throw stageError("compile_failed", compiled);
    manifest.binaryHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
    save(root, "manifest.json", manifest);
    const symbols = requireNative(binary, ["symbols"], "symbols_unavailable");
    report.stages.symbols = symbols;
    if (!symbols.auditSignal || !symbols.coalitionUsage)
      throw stageError("native_symbols_unavailable", symbols);
    const parent = parseMacProbeIdentity(
      requireNative(binary, ["inspect", String(process.pid)], "parent_identity"),
    );
    usage(binary, parent.coalitionId);
    const domain = command("/bin/launchctl", ["print", service.domain], {
      maxBuffer: 4 * 1024 * 1024,
    });
    if (domain.status !== 0)
      throw stageError("launchd_domain_unavailable", { status: domain.status, code: domain.code });
    manifest.nativeStarted = true;
    save(root, "manifest.json", manifest);
    const control = spawn(binary, ["control", root], { stdio: "ignore" });
    control.on("error", () => {
      interrupted = true;
    });
    const controlIdentity = await until(() => identityFile(root, "control.json"));
    report.stages.control = controlIdentity;
    writeFileSync(plist, macProbePlist(service.label, binary, root), { mode: 0o600, flag: "wx" });
    // Persist uncertainty BEFORE contacting launchd. An unknown response keeps
    // the exact cleanup target available; it never becomes permission to run AI.
    manifest.bootstrapped = true;
    save(root, "manifest.json", manifest);
    const started = command("/bin/launchctl", ["bootstrap", service.domain, plist]);
    if (started.status !== 0) throw stageError("launchd_bootstrap_failed", started);
    const rootIdentity = await until(() => identityFile(root, "root.json"));
    const initial = usage(binary, rootIdentity.coalitionId);
    report.stages.root = rootIdentity;
    report.stages.initial = initial;
    if (
      rootIdentity.coalitionId === parent.coalitionId ||
      !freshMacProbeCoalition(rootIdentity, controlIdentity, initial)
    )
      throw stageError("coalition_not_isolated");
    manifest.coalitionId = rootIdentity.coalitionId;
    save(root, "manifest.json", manifest);
    if (interrupted) throw stageError("probe_interrupted");
    writeFileSync(join(root, "go"), "go", { mode: 0o600, flag: "wx" });
    const childFile = await until(() => identityFile(root, "grandchild.json"));
    const running = await until(() => {
      const current = usage(binary, rootIdentity.coalitionId);
      return current.active === "2" && current.started === "3" && current.exited === "1"
        ? current
        : false;
    });
    const child = parseMacProbeIdentity(
      requireNative(binary, ["inspect", String(childFile.pid)], "child_identity"),
    );
    if (!sameMacProbeProcess(childFile, child)) throw stageError("child_identity_changed");
    report.stages.child = child;
    report.stages.running = running;
    const staleSignal = native(binary, ["stale", ...processArgs(rootIdentity)]);
    report.stages.staleSignal = staleSignal;
    if (staleSignal.ok || staleSignal.errno !== 3 || staleSignal.stage !== "audit_signal")
      throw stageError("stale_token_not_rejected");
    const writes = join(root, "writes.txt");
    await until(() => existsSync(writes));
    const before = statSync(writes).size;
    const rootSignal = signalOwned(binary, rootIdentity);
    report.stages.rootSignal = rootSignal;
    if (!rootSignal.ok) throw stageError("root_stop_not_exercised");
    await until(() => !stillAlive(binary, rootIdentity));
    await until(() => statSync(writes).size > before);
    const orphan = usage(binary, rootIdentity.coalitionId);
    report.stages.orphan = orphan;
    if (!stillAlive(binary, child)) throw stageError("orphan_not_observed");
    const stopped = signalOwned(binary, child);
    if (!stopped.ok) throw stageError("child_stop_not_exercised");
    await until(() => !stillAlive(binary, child));
    const removed = command("/bin/launchctl", ["bootout", service.target]);
    if (removed.status !== 0) throw stageError("service_removal_unverified", removed);
    manifest.serviceRemoved = true;
    save(root, "manifest.json", manifest);
    const final = await until(() => {
      const current = usage(binary, rootIdentity.coalitionId, true);
      return "absent" in current || current.active === "0" ? current : false;
    });
    const controlAfter = parseMacProbeIdentity(
      requireNative(binary, ["inspect", String(controlIdentity.pid)], "control_identity"),
    );
    report.stages.final = final;
    const evidence = {
      root: rootIdentity,
      child,
      control: controlIdentity,
      controlAfter,
      initial,
      running,
      orphan,
      final,
      staleSignal,
      rootGone: true,
      childGone: true,
      orphanWrote: true,
      serviceRemoved: true,
      cleanupVerified: true,
    };
    if (interrupted) throw stageError("probe_interrupted");
    Object.assign(report, assessMacSupervisionProbe(evidence));
  } catch (error) {
    report.blockers.push(
      typeof error.code === "string" ? error.code : (error.adapterCode ?? "probe_failed"),
    );
    report.failure = error.details ?? null;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    try {
      if (existsSync(binary)) report.cleanupVerified = await cleanup(root, manifest, binary);
      else if (!manifest.bootstrapped) {
        checkedRoot(root);
        rmSync(root, { recursive: true });
        report.cleanupVerified = true;
      }
    } catch (error) {
      report.status = "blocked";
      report.blockers.push(error.code ?? error.adapterCode ?? "cleanup_failed");
      report.cleanupDirectory = root;
      const quotedRoot = "'" + root.replaceAll("'", "'\\''") + "'";
      report.cleanupCommand = `npm run probe:macos-supervision --workspace @aif/runtime -- --cleanup ${quotedRoot}`;
    }
  }
  if (!report.cleanupVerified) {
    report.status = "blocked";
    report.blockers.push("cleanup_unverified");
  }
  return report;
}

if (process.platform !== "darwin") {
  console.log(
    JSON.stringify({
      status: "unsupported_platform",
      platform: process.platform,
      grantsExecution: false,
    }),
  );
  process.exitCode = 2;
} else if (process.argv[2] === "--cleanup" && process.argv.length === 4) {
  try {
    const root = checkedRoot(resolve(process.argv[3]));
    const path = join(root, "manifest.json");
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || statSync(path).size > 4096)
      throw stageError("cleanup_identity_rejected");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.version !== 1) throw stageError("cleanup_identity_rejected");
    await cleanup(root, manifest, join(root, "probe"));
    console.log(JSON.stringify({ status: "cleaned", grantsExecution: false }));
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "blocked",
        code: error.code ?? error.adapterCode ?? "cleanup_failed",
        grantsExecution: false,
      }),
    );
    process.exitCode = 1;
  }
} else if (process.argv.length !== 2) {
  console.log(JSON.stringify({ status: "invalid_arguments", grantsExecution: false }));
  process.exitCode = 2;
} else {
  try {
    const report = await probe();
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "probe_passed") process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "blocked",
        grantsExecution: false,
        code: error.code ?? error.adapterCode ?? "probe_setup_failed",
      }),
    );
    process.exitCode = 1;
  }
}
