import { RuntimeExecutionError } from "../errors.js";

export interface MacProbeIdentity {
  fixtureImage: boolean;
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  uniqueId: string;
  pidVersion: number;
  birthSeconds: string;
  birthMicros: number;
  coalitionId: string;
}
export interface MacProbeUsage {
  coalitionId: string;
  started: string;
  exited: string;
  active: string;
}
const uint = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
const decimal = (x: unknown): x is string =>
  typeof x === "string" && /^(0|[1-9][0-9]{0,19})$/.test(x) && BigInt(x) <= 0xffffffffffffffffn;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function invalid() {
  return new RuntimeExecutionError("Invalid native Mac probe evidence.", undefined, "transport", {
    adapterCode: "macos_probe_invalid",
  });
}
export function parseMacProbeIdentity(value: unknown): MacProbeIdentity {
  const row = record(value);
  if (
    row.ok !== true ||
    typeof row.fixtureImage !== "boolean" ||
    !uint(row.pid) ||
    row.pid === 0 ||
    !uint(row.ppid) ||
    !uint(row.pgid) ||
    !uint(row.uid) ||
    !decimal(row.uniqueId) ||
    row.uniqueId === "0" ||
    !uint(row.pidVersion) ||
    !decimal(row.birthSeconds) ||
    !uint(row.birthMicros) ||
    row.birthMicros >= 1000000 ||
    !decimal(row.coalitionId)
  )
    throw invalid();
  return {
    fixtureImage: row.fixtureImage,
    pid: row.pid,
    ppid: row.ppid,
    pgid: row.pgid,
    uid: row.uid,
    uniqueId: row.uniqueId,
    pidVersion: row.pidVersion,
    birthSeconds: row.birthSeconds,
    birthMicros: row.birthMicros,
    coalitionId: row.coalitionId,
  };
}
export function parseMacProbeUsage(value: unknown): MacProbeUsage {
  const row = record(value);
  if (
    row.ok !== true ||
    !decimal(row.coalitionId) ||
    row.coalitionId === "0" ||
    !decimal(row.started) ||
    !decimal(row.exited) ||
    !decimal(row.active) ||
    BigInt(row.started) < BigInt(row.exited) ||
    BigInt(row.started) - BigInt(row.exited) !== BigInt(row.active)
  )
    throw invalid();
  return {
    coalitionId: row.coalitionId,
    started: row.started,
    exited: row.exited,
    active: row.active,
  };
}
export function sameMacProbeProcess(a: MacProbeIdentity, b: MacProbeIdentity): boolean {
  return (
    a.pid === b.pid &&
    a.uniqueId === b.uniqueId &&
    a.pidVersion === b.pidVersion &&
    a.birthSeconds === b.birthSeconds &&
    a.birthMicros === b.birthMicros &&
    a.uid === b.uid &&
    a.coalitionId === b.coalitionId &&
    a.fixtureImage === b.fixtureImage
  );
}
export function assertMacProbeProcess(a: MacProbeIdentity, b: MacProbeIdentity): void {
  if (!sameMacProbeProcess(a, b))
    throw new RuntimeExecutionError(
      "The native fixture identity changed; cessation is unproven.",
      undefined,
      "transport",
      { adapterCode: "macos_probe_identity_changed" },
    );
}
export function isolatedMacProbeCoalition(
  root: MacProbeIdentity,
  control: MacProbeIdentity,
  usage: MacProbeUsage,
): boolean {
  return (
    root.fixtureImage &&
    control.fixtureImage &&
    root.uid === control.uid &&
    root.pid !== control.pid &&
    root.uniqueId !== control.uniqueId &&
    root.coalitionId !== "0" &&
    root.coalitionId !== control.coalitionId &&
    usage.coalitionId === root.coalitionId &&
    BigInt(usage.started) - BigInt(usage.exited) === 1n &&
    usage.active === "1"
  );
}

const probeUsageDeltas = {
  initial: [0n, 0n, "1"],
  running: [2n, 1n, "2"],
  orphan: [2n, 2n, "1"],
  stopped: [2n, 3n, "0"],
} as const;

/** Native counters include completed startup tasks. Freeze the root-only
 * baseline before allowing forks; never rebase after fixture execution begins. */
export function macProbeUsageMatches(
  initial: MacProbeUsage,
  current: MacProbeUsage,
  phase: keyof typeof probeUsageDeltas,
): boolean {
  const [started, exited, active] = probeUsageDeltas[phase];
  return (
    initial.active === "1" &&
    BigInt(initial.started) - BigInt(initial.exited) === 1n &&
    current.coalitionId === initial.coalitionId &&
    BigInt(current.started) === BigInt(initial.started) + started &&
    BigInt(current.exited) === BigInt(initial.exited) + exited &&
    current.active === active
  );
}
export interface MacSupervisionProbeEvidence {
  root: MacProbeIdentity;
  child: MacProbeIdentity;
  control: MacProbeIdentity;
  controlAfter: MacProbeIdentity;
  initial: MacProbeUsage;
  running: MacProbeUsage;
  orphan: MacProbeUsage;
  final: MacProbeUsage | { coalitionId: string; absent: true; errno: 3 };
  staleSignal: { ok: boolean; stage: string; errno: number; stale: boolean };
  rootGone: boolean;
  childGone: boolean;
  orphanWrote: boolean;
  serviceRemoved: boolean;
  cleanupVerified: boolean;
}

/** A successful diagnostic is not an execution capability or stop receipt.
 * No result from this module can release a grant or enable a runtime. */
export function assessMacSupervisionProbe(value: MacSupervisionProbeEvidence) {
  const blockers: string[] = [];
  if (!isolatedMacProbeCoalition(value.root, value.control, value.initial))
    blockers.push("coalition_not_isolated");
  if (
    !value.child.fixtureImage ||
    value.child.coalitionId !== value.root.coalitionId ||
    value.child.uid !== value.root.uid ||
    value.child.pid === value.root.pid ||
    value.child.uniqueId === value.root.uniqueId ||
    value.child.pgid === value.root.pgid ||
    value.child.ppid !== 1
  )
    blockers.push("detached_child_not_bound");
  if (!macProbeUsageMatches(value.initial, value.running, "running"))
    blockers.push("running_accounting_mismatch");
  if (
    !value.rootGone ||
    !value.orphanWrote ||
    !macProbeUsageMatches(value.initial, value.orphan, "orphan")
  )
    blockers.push("orphan_accounting_unproven");
  if (
    value.staleSignal.ok !== false ||
    value.staleSignal.stage !== "audit_signal" ||
    value.staleSignal.errno !== 3 ||
    value.staleSignal.stale !== true
  )
    blockers.push("stale_pid_not_rejected_by_kernel");
  if (!sameMacProbeProcess(value.control, value.controlAfter))
    blockers.push("unrelated_process_changed");
  const ended =
    "absent" in value.final
      ? value.final.absent === true && value.final.errno === 3
      : macProbeUsageMatches(value.initial, value.final, "stopped");
  if (
    value.final.coalitionId !== value.root.coalitionId ||
    !ended ||
    !value.childGone ||
    !value.serviceRemoved
  )
    blockers.push("empty_coalition_unproven");
  if (!value.cleanupVerified) blockers.push("cleanup_unverified");
  return {
    status: blockers.length === 0 ? ("probe_passed" as const) : ("blocked" as const),
    grantsExecution: false as const,
    blockers,
  };
}

/** Only this nonce-derived label can be bootstrapped or removed by the probe. */
export function macProbeService(uid: number, id: string) {
  if (
    !uint(uid) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
  )
    throw invalid();
  const label = `com.aif.handoff.probe.${id}`;
  return { label, domain: `gui/${uid}`, target: `gui/${uid}/${label}` };
}

export interface MacProbeManifest {
  version: 1;
  id: string;
  uid: number;
  driverPid: number;
  target: string;
  bootstrapped: boolean;
  serviceRemoved: boolean;
  nativeStarted: boolean;
  coalitionId: string | null;
  binaryHash: string | null;
}
export function parseMacProbeManifest(value: unknown, uid: number): MacProbeManifest {
  const row = record(value);
  if (
    row.version !== 1 ||
    row.uid !== uid ||
    !uint(row.driverPid) ||
    row.driverPid === 0 ||
    typeof row.id !== "string" ||
    row.target !== macProbeService(uid, row.id).target ||
    typeof row.bootstrapped !== "boolean" ||
    typeof row.serviceRemoved !== "boolean" ||
    typeof row.nativeStarted !== "boolean" ||
    (row.coalitionId !== null && (!decimal(row.coalitionId) || row.coalitionId === "0")) ||
    (row.binaryHash !== null &&
      (typeof row.binaryHash !== "string" || !/^[a-f0-9]{64}$/.test(row.binaryHash))) ||
    (row.nativeStarted && row.binaryHash === null) ||
    (row.bootstrapped && !row.nativeStarted) ||
    (row.coalitionId !== null && !row.bootstrapped) ||
    (row.serviceRemoved && !row.bootstrapped)
  )
    throw invalid();
  return {
    version: 1,
    id: row.id,
    uid,
    driverPid: row.driverPid,
    target: row.target,
    bootstrapped: row.bootstrapped,
    serviceRemoved: row.serviceRemoved,
    nativeStarted: row.nativeStarted,
    coalitionId: row.coalitionId,
    binaryHash: row.binaryHash,
  };
}
export function macProbePlist(label: string, executable: string, directory: string) {
  const xml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(executable)}</string><string>worker</string><string>${xml(directory)}</string></array><key>WorkingDirectory</key><string>${xml(directory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><true/><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(directory)}/launchd.out</string><key>StandardErrorPath</key><string>${xml(directory)}/launchd.err</string></dict></plist>\n`;
}
