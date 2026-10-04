import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assessMacSupervisionProbe,
  assertMacProbeProcess,
  isolatedMacProbeCoalition,
  macProbePlist,
  macProbeService,
  macProbeUsageMatches,
  parseMacProbeIdentity,
  parseMacProbeManifest,
  parseMacProbeUsage,
  sameMacProbeProcess,
  type MacSupervisionProbeEvidence,
  type MacProbeIdentity,
} from "../supervision/macosProbe.js";

const root: MacProbeIdentity = {
  fixtureImage: true,
  pid: 100,
  ppid: 1,
  pgid: 100,
  uid: 501,
  uniqueId: "9007199254740993",
  pidVersion: 4,
  birthSeconds: "1790000000",
  birthMicros: 42,
  coalitionId: "50",
};
const child = { ...root, pid: 102, pgid: 101, uniqueId: "9007199254740995", pidVersion: 6 };
const control = { ...root, pid: 80, uniqueId: "9007199254740900", coalitionId: "40" };
function evidence(): MacSupervisionProbeEvidence {
  return {
    root: { ...root },
    child: { ...child },
    control: { ...control },
    controlAfter: { ...control },
    initial: { coalitionId: "50", started: "1", exited: "0", active: "1" },
    running: { coalitionId: "50", started: "3", exited: "1", active: "2" },
    orphan: { coalitionId: "50", started: "3", exited: "2", active: "1" },
    final: { coalitionId: "50", started: "3", exited: "3", active: "0" },
    staleSignal: { ok: false, stage: "audit_signal", errno: 3, stale: true },
    rootGone: true,
    childGone: true,
    orphanWrote: true,
    serviceRemoved: true,
    cleanupVerified: true,
  };
}
describe("macOS native supervision diagnostic evidence", () => {
  it("rejects incomplete or substituted cleanup ownership before acting on a saved manifest", () => {
    const id = "019b3812-6320-4000-8000-999999999999";
    const valid = {
      version: 1,
      id,
      uid: 501,
      driverPid: 777,
      target: macProbeService(501, id).target,
      bootstrapped: false,
      serviceRemoved: false,
      nativeStarted: false,
      coalitionId: null,
      binaryHash: null,
    };
    expect(parseMacProbeManifest(valid, 501)).toEqual(valid);
    for (const patch of [
      { uid: 502 },
      { target: "gui/501/unrelated" },
      { nativeStarted: undefined },
      { nativeStarted: true },
      { bootstrapped: true },
      { serviceRemoved: true },
      { coalitionId: "42" },
      { binaryHash: "bad" },
    ])
      expect(() => parseMacProbeManifest({ ...valid, ...patch }, 501)).toThrow();
    expect(
      parseMacProbeManifest(
        {
          ...valid,
          nativeStarted: true,
          bootstrapped: true,
          coalitionId: "42",
          binaryHash: "a".repeat(64),
        },
        501,
      ).coalitionId,
    ).toBe("42");
  });
  it("keeps full-width native identities and checks accounting without floating-point rounding", () => {
    expect(parseMacProbeIdentity({ ok: true, ...root })).toEqual(root);
    expect(
      parseMacProbeUsage({
        ok: true,
        coalitionId: "50",
        started: "9007199254740995",
        exited: "9007199254740993",
        active: "2",
      }).active,
    ).toBe("2");
    expect(() =>
      parseMacProbeUsage({
        ok: true,
        coalitionId: "50",
        started: "9007199254740995",
        exited: "9007199254740993",
        active: "1",
      }),
    ).toThrow();
    for (const bad of [
      null,
      [],
      {},
      { ok: true, ...root, uniqueId: 9007199254740993 },
      { ok: true, ...root, pid: 0 },
      { ok: true, ...root, birthMicros: 1000000 },
      { ok: true, ...root, coalitionId: "18446744073709551616" },
    ])
      expect(() => parseMacProbeIdentity(bad)).toThrow(
        expect.objectContaining({ adapterCode: "macos_probe_invalid" }),
      );
    expect(() => parseMacProbeUsage({ ok: false, errno: 3 })).toThrow();
  });
  it("requires a dedicated coalition with only the live root before the fixture may fork", () => {
    const good = evidence();
    expect(isolatedMacProbeCoalition(root, control, good.initial)).toBe(true);
    expect(
      isolatedMacProbeCoalition(root, { ...control, coalitionId: root.coalitionId }, good.initial),
    ).toBe(false);
    expect(
      isolatedMacProbeCoalition(root, control, { ...good.initial, started: "20", exited: "19" }),
    ).toBe(true);
    expect(
      isolatedMacProbeCoalition(root, control, { ...good.initial, started: "20", exited: "18" }),
    ).toBe(false);
    expect(
      isolatedMacProbeCoalition(root, control, { ...good.initial, started: "20", exited: "20" }),
    ).toBe(false);
  });
  it.each(["1", "2", "20", "9007199254740993"])(
    "keeps exact fixture deltas from the frozen startup counter %s",
    (started) => {
      const x = evidence();
      const count = BigInt(started);
      x.initial = { coalitionId: "50", started, exited: String(count - 1n), active: "1" };
      x.running = { coalitionId: "50", started: String(count + 2n), exited: started, active: "2" };
      x.orphan = { ...x.running, exited: String(count + 1n), active: "1" };
      x.final = { ...x.running, exited: String(count + 2n), active: "0" };
      expect(macProbeUsageMatches(x.initial, x.initial, "initial")).toBe(true);
      expect(assessMacSupervisionProbe(x)).toEqual({
        status: "probe_passed",
        grantsExecution: false,
        blockers: [],
      });
    },
  );
  it("refuses a drifting baseline even when only one task remains active", () => {
    const initial = { coalitionId: "50", started: "2", exited: "1", active: "1" };
    expect(
      macProbeUsageMatches(initial, { ...initial, started: "3", exited: "2" }, "initial"),
    ).toBe(false);
    expect(macProbeUsageMatches(initial, { ...initial, coalitionId: "60" }, "initial")).toBe(false);
  });
  it("rejects reset counters and additional completed tasks despite matching active counts", () => {
    const reset = evidence();
    reset.initial = { ...reset.initial, started: "2", exited: "1" };
    expect(assessMacSupervisionProbe(reset).blockers).toContain("running_accounting_mismatch");
    for (const phase of ["running", "orphan", "final"] as const) {
      const x = evidence();
      const counts = x[phase];
      if ("absent" in counts) throw new Error("Expected accounting fixture");
      counts.started = String(BigInt(counts.started) + 1n);
      counts.exited = String(BigInt(counts.exited) + 1n);
      expect(assessMacSupervisionProbe(x).status).toBe("blocked");
    }
  });
  it("accepts complete native observations only as a diagnostic, never an execution grant", () => {
    expect(assessMacSupervisionProbe(evidence())).toEqual({
      status: "probe_passed",
      grantsExecution: false,
      blockers: [],
    });
    const gone = evidence();
    gone.final = { coalitionId: "50", absent: true, errno: 3 };
    expect(assessMacSupervisionProbe(gone).status).toBe("probe_passed");
  });
  it.each([
    [
      "foreign executable",
      (x: MacSupervisionProbeEvidence) => {
        x.child.fixtureImage = false;
      },
    ],
    [
      "shared coalition",
      (x: MacSupervisionProbeEvidence) => {
        x.control.coalitionId = "50";
      },
    ],
    [
      "escaped child",
      (x: MacSupervisionProbeEvidence) => {
        x.child.coalitionId = "51";
      },
    ],
    [
      "ordinary child only",
      (x: MacSupervisionProbeEvidence) => {
        x.child.pgid = x.root.pgid;
      },
    ],
    [
      "unknown group member",
      (x: MacSupervisionProbeEvidence) => {
        x.running.active = "3";
      },
    ],
    [
      "absent orphan evidence",
      (x: MacSupervisionProbeEvidence) => {
        x.orphanWrote = false;
      },
    ],
    [
      "root still alive",
      (x: MacSupervisionProbeEvidence) => {
        x.rootGone = false;
      },
    ],
    [
      "stale signal accepted",
      (x: MacSupervisionProbeEvidence) => {
        x.staleSignal.ok = true;
      },
    ],
    [
      "userspace-only PID check",
      (x: MacSupervisionProbeEvidence) => {
        x.staleSignal.stage = "identity_mismatch";
      },
    ],
    [
      "permission denied",
      (x: MacSupervisionProbeEvidence) => {
        x.staleSignal.errno = 1;
      },
    ],
    [
      "reused control PID",
      (x: MacSupervisionProbeEvidence) => {
        x.controlAfter.uniqueId = "999";
      },
    ],
    [
      "wrong final coalition",
      (x: MacSupervisionProbeEvidence) => {
        x.final.coalitionId = "60";
      },
    ],
    [
      "incomplete stop",
      (x: MacSupervisionProbeEvidence) => {
        x.childGone = false;
      },
    ],
    [
      "registered service",
      (x: MacSupervisionProbeEvidence) => {
        x.serviceRemoved = false;
      },
    ],
    [
      "cleanup failed",
      (x: MacSupervisionProbeEvidence) => {
        x.cleanupVerified = false;
      },
    ],
  ] as const)("blocks %s", (_name, mutate) => {
    const value = evidence();
    mutate(value);
    const report = assessMacSupervisionProbe(value);
    expect(report.status).toBe("blocked");
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(report.grantsExecution).toBe(false);
  });
  it("does not confuse a PID with its incarnation or accept another device-local coalition", () => {
    expect(sameMacProbeProcess(root, { ...root })).toBe(true);
    expect(() => assertMacProbeProcess(root, { ...root })).not.toThrow();
    for (const patch of [
      { pidVersion: 5 },
      { birthMicros: 43 },
      { uid: 502 },
      { coalitionId: "60" },
    ]) {
      expect(sameMacProbeProcess(root, { ...root, ...patch })).toBe(false);
      expect(() => assertMacProbeProcess(root, { ...root, ...patch })).toThrow(
        expect.objectContaining({ adapterCode: "macos_probe_identity_changed" }),
      );
    }
  });
  it("restricts launchd identifiers to this probe and encodes literal paths as XML", () => {
    const id = "019b3812-6320-4000-8000-999999999999";
    const service = macProbeService(501, id);
    expect(service.target).toBe(`gui/501/com.aif.handoff.probe.${id}`);
    expect(() => macProbeService(501, "../another-service")).toThrow();
    expect(() => macProbeService(-1, id)).toThrow();
    const xml = macProbePlist(service.label, '/tmp/a&b<"/probe', "/tmp/a'b>");
    expect(xml).toContain("a&amp;b&lt;&quot;");
    expect(xml).toContain("a&apos;b&gt;");
    expect(xml).toContain("<key>KeepAlive</key><false/>");
    expect(xml).not.toContain("/bin/sh");
  });
  it.skipIf(process.platform === "darwin")(
    "exits before compiling or loading launchd on other platforms",
    () => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../../scripts/macos-supervision-probe.mjs", import.meta.url)),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({
        status: "unsupported_platform",
        platform: process.platform,
        grantsExecution: false,
      });
    },
  );
});
