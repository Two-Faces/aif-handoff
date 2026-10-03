import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  processHostIdentitySchema,
  preparedProcessIdentitySchema,
  processStopEvidenceSchema,
  processHostIdentity,
  nativeMacUsageSchema,
} from "../processSupervision.js";
const id = randomUUID();
const host = {
  version: 1,
  mechanism: "windows_job_v1",
  id,
  jobName: `Local\\AifHandoff-${id}`,
  hostPid: 123,
  hostSessionId: 1,
  hostBirth: "134354612414239081",
};
describe("local native supervision contracts", () => {
  it("rejects malformed native accounting without throwing from the schema validator", () => {
    const usage = {
      kind: "usage",
      started: "9007199254740993",
      exited: "9007199254740992",
      active: "1",
    };
    expect(nativeMacUsageSchema.parse(usage)).toEqual(usage);
    for (const patch of [
      { started: "bad" },
      { exited: "-1" },
      { active: "2" },
      { started: 9007199254740993 },
    ])
      expect(nativeMacUsageSchema.safeParse({ ...usage, ...patch }).success).toBe(false);
  });
  const macHost = {
    version: 1,
    mechanism: "macos_coalition_v1",
    id,
    serviceName: `com.aif.handoff.supervisor-${id}`,
    hostPid: 123,
    hostBirth: "1790994215911465",
    hostUid: 501,
    hostUniqueId: "9007199254740993",
    hostPidVersion: 7,
    bootSessionId: randomUUID(),
    coalitionId: "4577",
  };
  it("keeps full Mac identities in the durable host projection without child fields", () => {
    const parsed = processHostIdentitySchema.parse(macHost);
    const child = preparedProcessIdentitySchema.parse({
      ...macHost,
      pid: 124,
      birth: "1790994216911465",
      uniqueId: "9007199254740994",
      pidVersion: 8,
    });
    expect(processHostIdentity(parsed)).toEqual(macHost);
    expect(processHostIdentity(child)).toEqual(macHost);
    expect(
      processHostIdentity(preparedProcessIdentitySchema.parse({ ...host, pid: 124, birth: "123" })),
    ).toEqual(host);
    expect(
      processStopEvidenceSchema.safeParse({
        identity: child,
        activeProcesses: 0,
        reason: "completed",
        exitCode: 0,
        terminatedProcesses: 1,
      }).success,
    ).toBe(true);
  });
  it.each([
    { serviceName: "gui/501/foreign" },
    { bootSessionId: "missing" },
    { hostUid: -1 },
    { coalitionId: "0" },
    { coalitionId: "18446744073709551616" },
    { hostUniqueId: "not-a-number" },
    { hostUniqueId: 9007199254740993 },
    { hostPidVersion: 0x100000000 },
    { jobName: "foreign" },
  ])("rejects a malformed or cross-mechanism Mac identity %j", (patch) => {
    expect(processHostIdentitySchema.safeParse({ ...macHost, ...patch }).success).toBe(false);
  });
  it("binds PID to birth time and the exact job name, with a separate suspended-child receipt", () => {
    expect(processHostIdentitySchema.parse(host)).toEqual(host);
    expect(
      preparedProcessIdentitySchema.parse({ ...host, pid: 124, birth: "134354612425510935" }).pid,
    ).toBe(124);
    for (const invalid of [
      { ...host, jobName: "another" },
      { ...host, hostBirth: "0" },
      { ...host, hostPid: -1 },
      { ...host, command: "run" },
    ])
      expect(processHostIdentitySchema.safeParse(invalid).success).toBe(false);
  });
  it("requires zero native membership and discriminates recovery from ordinary exit evidence", () => {
    const recovered = {
      identity: host,
      activeProcesses: 0,
      reason: "recovered",
      exitCode: null,
      terminatedProcesses: null,
    };
    expect(processStopEvidenceSchema.safeParse(recovered).success).toBe(true);
    expect(processStopEvidenceSchema.safeParse({ ...recovered, activeProcesses: 1 }).success).toBe(
      false,
    );
    expect(processStopEvidenceSchema.safeParse({ ...recovered, reason: "completed" }).success).toBe(
      false,
    );
    expect(
      processStopEvidenceSchema.safeParse({
        ...recovered,
        reason: "cancelled",
        exitCode: 137,
        terminatedProcesses: 2,
      }).success,
    ).toBe(true);
    expect(processStopEvidenceSchema.safeParse({ ...recovered, exitCode: 0 }).success).toBe(false);
  });
});
