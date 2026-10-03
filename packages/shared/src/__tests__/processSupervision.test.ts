import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  processHostIdentitySchema,
  preparedProcessIdentitySchema,
  processStopEvidenceSchema,
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
