import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@aif/shared/server";
import {
  localDevice,
  resetEnvCache,
  taskDeviceProcesses,
  tasks,
  type ProcessHostIdentity,
  type PreparedProcessIdentity,
  type ProcessStopEvidence,
} from "@aif/shared";
const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
const data = await import("../index.js");
let directory: string;
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  db.current.$client.close();
  db.current = createTestDb();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-process-journal-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const project = data.createProject({
    name: "Process fixture",
    rootPath: join(directory, "source"),
    personalMode: false,
  })!;
  const task = data.createTask({
    projectId: project.id,
    title: "task",
    description: "",
    paused: true,
    autoMode: false,
  })!;
  mkdirSync(project.rootPath);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project.rootPath, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(project.rootPath, "task.txt"), "base\n");
  git("add", "task.txt");
  git("-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  data.prepareTaskExecutionWorkspace({
    projectId: project.id,
    taskId: task.id,
    projectRoot: project.rootPath,
    worktreePath: join(directory, "task"),
    snapshotCommit: git("rev-parse", "HEAD"),
  });
  data.initializeTaskDeviceGrant(task.id);
  return { task, input: { taskId: task.id, projectRoot: project.rootPath } };
}
function identities() {
  const id = randomUUID();
  const host: ProcessHostIdentity = {
    version: 1,
    mechanism: "windows_job_v1",
    id,
    jobName: `Local\\AifHandoff-${id}`,
    hostPid: 123,
    hostSessionId: 1,
    hostBirth: "134354612414239081",
  };
  const prepared: PreparedProcessIdentity = { ...host, pid: 124, birth: "134354612425510935" };
  const evidence: ProcessStopEvidence = {
    identity: prepared,
    activeProcesses: 0,
    reason: "completed",
    exitCode: 0,
    terminatedProcesses: 0,
  };
  return { host, prepared, evidence };
}
describe("durable local process supervision journal", () => {
  it("persists Mac boot, user and coalition bindings and refuses substituted recovery evidence", async () => {
    const { task, input } = fixture(),
      supervisorId = randomUUID();
    const host: ProcessHostIdentity = {
      version: 1,
      mechanism: "macos_coalition_v1",
      id: supervisorId,
      serviceName: `com.aif.handoff.supervisor-${supervisorId}`,
      hostPid: 123,
      hostBirth: "1790994215911465",
      hostUid: 501,
      hostUniqueId: "9007199254740993",
      hostPidVersion: 7,
      bootSessionId: randomUUID(),
      coalitionId: "4577",
    };
    let id = "";
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        const journal = data.createTaskDeviceProcessJournal(task.id);
        id = journal.id;
        await journal.onIdentity(host);
        const prepared = {
          ...host,
          pid: 124,
          birth: "1790994216911465",
          uniqueId: "9007199254740994",
          pidVersion: 8,
        };
        await expect(
          journal.onPrepared({ ...prepared, coalitionId: "4578" }),
        ).rejects.toMatchObject({ code: "process_conflict" });
        await journal.onPrepared(prepared);
      }),
    ).rejects.toMatchObject({ code: "process_stop_unproven" });
    expect(data.getTaskDeviceProcessRecovery(id)).toEqual(host);
    const grant = data.getTaskDeviceGrant(task.id);
    const recovery = {
      identity: host,
      activeProcesses: 0,
      reason: "recovered",
      exitCode: null,
      terminatedProcesses: null,
    };
    for (const patch of [
      { bootSessionId: randomUUID() },
      { hostUid: 502 },
      { coalitionId: "4578" },
      { hostPidVersion: 8 },
    ])
      expect(() =>
        data.recordTaskDeviceProcessRecovery(id, { ...recovery, identity: { ...host, ...patch } }),
      ).toThrow(expect.objectContaining({ code: "process_conflict" }));
    data.recordTaskDeviceProcessRecovery(id, recovery);
    const stopped = data.getTaskDeviceProcess(id);
    data.recordTaskDeviceProcessRecovery(id, recovery);
    expect(data.getTaskDeviceProcess(id)).toEqual(stopped);
    expect(data.getTaskDeviceGrant(task.id)).toEqual(grant);
  });
  it("persists ordered identity/child/stop receipts before a managed run can settle", async () => {
    const { task, input } = fixture(),
      { host, prepared, evidence } = identities();
    let id = "",
      runId = "";
    await data.withTaskDeviceExecution(input, async () => {
      const journal = data.createTaskDeviceProcessJournal(task.id);
      id = journal.id;
      runId = data.currentTaskDeviceRunId()!;
      expect(data.getTaskDeviceProcess(id).state).toBe("reserved");
      await journal.onIdentity(host);
      await journal.onIdentity(host);
      expect(data.getTaskDeviceProcess(id).state).toBe("identified");
      await journal.onPrepared(prepared);
      await journal.onPrepared(prepared);
      await journal.onStopped(evidence);
      await journal.onStopped(evidence);
      expect(() => data.getTaskDeviceProcessRecovery(id)).toThrow(
        expect.objectContaining({ code: "run_scope_required" }),
      );
    });
    expect(data.getTaskDeviceRun(runId)?.state).toBe("settled");
    expect(data.listTaskDeviceProcesses(runId)).toHaveLength(1);
    expect(data.getTaskDeviceProcessRecovery(id)).toEqual(host);
    const original = data.getTaskDeviceProcess(id);
    data.recordTaskDeviceProcessRecovery(id, {
      identity: host,
      activeProcesses: 0,
      reason: "recovered",
      exitCode: null,
      terminatedProcesses: null,
    });
    expect(data.getTaskDeviceProcess(id)).toEqual(original);
  });
  it("retains an uncertain run after a returned JS callback while its native process is unresolved", async () => {
    const { task, input } = fixture(),
      { host, prepared } = identities();
    let id = "";
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        const journal = data.createTaskDeviceProcessJournal(task.id);
        id = journal.id;
        await journal.onIdentity(host);
        await journal.onPrepared(prepared);
      }),
    ).rejects.toMatchObject({ code: "process_stop_unproven" });
    const before = data.getTaskDeviceGrant(task.id)!;
    data.recordTaskDeviceProcessRecovery(id, {
      identity: data.getTaskDeviceProcessRecovery(id),
      activeProcesses: 0,
      reason: "recovered",
      exitCode: null,
      terminatedProcesses: null,
    });
    expect(data.getTaskDeviceProcess(id).state).toBe("stopped");
    expect(data.getTaskDeviceGrant(task.id)).toEqual(before);
    expect(data.getTaskDeviceRun(before.activeRunId!)?.state).toBe("uncertain");
    await expect(data.withTaskDeviceExecution(input, async () => undefined)).rejects.toMatchObject({
      code: "run_busy",
    });
  });
  it("refuses fabricated identities, out-of-order receipts and evidence for another process", async () => {
    const { task, input } = fixture(),
      { host, prepared, evidence } = identities();
    await data.withTaskDeviceExecution(input, async () => {
      const journal = data.createTaskDeviceProcessJournal(task.id);
      await expect(journal.onPrepared(prepared)).rejects.toMatchObject({
        code: "process_conflict",
      });
      await expect(journal.onIdentity({ ...host, jobName: "foreign" })).rejects.toMatchObject({
        code: "process_invalid",
      });
      await journal.onIdentity(host);
      await expect(journal.onIdentity(identities().host)).rejects.toMatchObject({
        code: "process_conflict",
      });
      await expect(journal.onPrepared({ ...prepared, hostPid: 500 })).rejects.toMatchObject({
        code: "process_conflict",
      });
      await journal.onPrepared(prepared);
      await expect(
        journal.onStopped({ ...evidence, identity: { ...prepared, pid: 500 } }),
      ).rejects.toMatchObject({ code: "process_conflict" });
      await journal.onStopped(evidence);
      await expect(journal.onStopped({ ...evidence, exitCode: 1 })).rejects.toMatchObject({
        code: "process_conflict",
      });
    });
  });
  it("records stop evidence after fencing without admitting late result writes", async () => {
    const { task, input } = fixture(),
      { host, prepared, evidence } = identities();
    let id = "";
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        const journal = data.createTaskDeviceProcessJournal(task.id);
        id = journal.id;
        await journal.onIdentity(host);
        await journal.onPrepared(prepared);
        data.invalidateTaskDeviceExecution();
        await journal.onStopped({ ...evidence, reason: "cancelled", exitCode: 137 });
        expect(() => data.assertTaskDeviceExecution(task.id)).toThrow(
          expect.objectContaining({ code: "run_fenced" }),
        );
      }),
    ).rejects.toMatchObject({ code: "run_fenced" });
    expect(data.getTaskDeviceProcess(id).state).toBe("stopped");
    expect(data.getTaskDeviceGrant(task.id)?.activeRunId).not.toBeNull();
  });
  it("keeps unresolved reservations local, rejects stale callbacks and preserves receipts after task deletion", async () => {
    const { task, input } = fixture();
    let journal: ReturnType<typeof data.createTaskDeviceProcessJournal> | undefined;
    expect(() => data.createTaskDeviceProcessJournal(task.id)).toThrow(
      expect.objectContaining({ code: "run_scope_required" }),
    );
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        journal = data.createTaskDeviceProcessJournal(task.id);
      }),
    ).rejects.toMatchObject({ code: "process_stop_unproven" });
    const { host } = identities();
    await expect(journal!.onIdentity(host)).rejects.toMatchObject({ code: "run_fenced" });
    expect(() => data.getTaskDeviceProcessRecovery(journal!.id)).toThrow(
      expect.objectContaining({ code: "process_stop_unproven" }),
    );
    db.current.delete(tasks).where(eq(tasks.id, task.id)).run();
    expect(data.getTaskDeviceProcess(journal!.id).state).toBe("reserved");
    expect(() => data.getTaskDeviceProcess("missing")).toThrow(
      expect.objectContaining({ code: "process_missing" }),
    );
    db.current
      .update(localDevice)
      .set({ deviceId: randomUUID() })
      .where(eq(localDevice.slot, 1))
      .run();
    expect(() => data.getTaskDeviceProcessRecovery(journal!.id)).toThrow(
      expect.objectContaining({ code: "process_conflict" }),
    );
  });
  it("rejects corrupted persisted identities and non-recovery claims at the recovery boundary", async () => {
    const { task, input } = fixture(),
      { host, prepared, evidence } = identities();
    let id = "";
    await expect(
      data.withTaskDeviceExecution(input, async () => {
        const journal = data.createTaskDeviceProcessJournal(task.id);
        id = journal.id;
        await journal.onIdentity(host);
        await journal.onPrepared(prepared);
      }),
    ).rejects.toMatchObject({ code: "process_stop_unproven" });
    expect(() => data.recordTaskDeviceProcessRecovery(id, evidence)).toThrow(
      expect.objectContaining({ code: "process_invalid" }),
    );
    expect(() =>
      data.recordTaskDeviceProcessRecovery(id, {
        identity: identities().host,
        activeProcesses: 0,
        reason: "recovered",
        exitCode: null,
        terminatedProcesses: null,
      }),
    ).toThrow(expect.objectContaining({ code: "process_conflict" }));
    db.current
      .update(taskDeviceProcesses)
      .set({ identityJson: "{" })
      .where(eq(taskDeviceProcesses.id, id))
      .run();
    expect(() => data.getTaskDeviceProcessRecovery(id)).toThrow(
      expect.objectContaining({ code: "process_invalid" }),
    );
  });
});
