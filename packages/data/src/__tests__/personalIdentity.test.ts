import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { localDevice, participants, projects, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aif/shared/server")>()),
  getDb: () => testDb.current,
}));
const data = await import("../index.js");
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  testDb.current.$client.close();
  testDb.current = createTestDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
});

function person(id = crypto.randomUUID(), active = true) {
  testDb.current
    .insert(participants)
    .values({
      id,
      username: id,
      normalizedUsername: id,
      displayName: "Owner",
      passwordHash: "local-only-secret",
      role: "member",
      active,
    })
    .run();
  return id;
}
function project() {
  return data.createProject({ name: "Project", rootPath: "local-root", personalMode: true })!;
}

describe("local device identity", () => {
  it("retains stable IDs and refuses a DB clone from another installation", () => {
    const before = data.getLocalDevice();
    expect(data.initializeLocalDevice("installation-a", "Windows")).toEqual({
      ...before,
      name: "Windows",
    });
    expect(() => data.initializeLocalDevice("installation-b", "Mac")).toThrow(
      expect.objectContaining({ code: "device_identity_mismatch" }),
    );
    expect(data.getLocalDevice()).toEqual({ ...before, name: "Windows" });
    expect(() => data.initializeLocalDevice("", "")).toThrow(
      expect.objectContaining({ code: "device_not_initialized" }),
    );
  });

  it("refuses a second process owner until the first releases", () => {
    const release = data.acquireLocalDeviceLock("installation", "Windows");
    expect(() => data.acquireLocalDeviceLock("installation", "Windows")).toThrow(
      expect.objectContaining({ code: "device_in_use" }),
    );
    release();
    const releaseSecond = data.acquireLocalDeviceLock("installation", "Windows");
    release(); // A delayed release cannot clear a successor's lock.
    expect(() => data.acquireLocalDeviceLock("installation", "Windows")).toThrow(
      expect.objectContaining({ code: "device_in_use" }),
    );
    releaseSecond();
  });

  it("requires proven process exit and fails closed on permission errors", () => {
    testDb.current
      .update(localDevice)
      .set({ ownerPid: 123456, ownerToken: "stale" })
      .where(eq(localDevice.slot, 1))
      .run();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("unknown"), { code: "EPERM" });
    });
    expect(() => data.acquireLocalDeviceLock("installation", "Windows")).toThrow(
      expect.objectContaining({ code: "device_in_use" }),
    );
    kill.mockImplementation(() => {
      throw Object.assign(new Error("stopped"), { code: "ESRCH" });
    });
    const release = data.acquireLocalDeviceLock("installation", "Windows");
    release();
  });
});

describe("project bindings", () => {
  it("registers a project and checkout atomically and rolls back ambiguous reuse", () => {
    const input = {
      name: "Existing",
      rootPath: "windows-root",
      executionEnvironment: "native_windows" as const,
      head: "a".repeat(40),
      branch: "feature",
    };
    const created = data.registerPersonalCheckout(input);
    expect(data.listProjectCheckouts(created.id)).toHaveLength(1);
    expect(() => data.registerPersonalCheckout(input)).toThrow(
      expect.objectContaining({ code: "checkout_already_bound" }),
    );
    expect(data.listProjects()).toHaveLength(1);
    expect(data.registerPersonalCheckout({ ...input, projectId: created.id }).id).toBe(created.id);
    expect(data.listProjectCheckouts(created.id)).toHaveLength(1);
  });

  it("keeps different Windows/WSL checkout roots on one explicitly selected board", () => {
    const first = data.registerPersonalCheckout({
      name: "Existing",
      rootPath: "windows-root",
      executionEnvironment: "native_windows",
      head: null,
      branch: "main",
    });
    data.registerPersonalCheckout({
      projectId: first.id,
      name: "ignored",
      rootPath: "wsl-root",
      executionEnvironment: "wsl",
      head: "b".repeat(40),
      branch: "feature",
    });
    expect(
      data
        .listProjectCheckouts(first.id)
        .map((binding) => binding.localRoot)
        .sort(),
    ).toEqual(["windows-root", "wsl-root"]);
    expect(data.findProjectById(first.id)?.rootPath).toBe("windows-root");
  });

  it("rejects missing projects and implicit conversion of standalone projects", () => {
    const input = {
      projectId: "missing",
      name: "Existing",
      rootPath: "root",
      executionEnvironment: "unknown" as const,
      head: null,
      branch: null,
    };
    expect(() => data.registerPersonalCheckout(input)).toThrow(
      expect.objectContaining({ code: "project_not_found" }),
    );
    expect(() =>
      data.bindProjectCheckout({
        projectId: "missing",
        localRoot: "root",
        executionEnvironment: "unknown",
        head: null,
        branch: null,
      }),
    ).toThrow(expect.objectContaining({ code: "project_not_found" }));
    const standalone = data.createProject({ name: "Standalone", rootPath: "root" })!;
    expect(() => data.registerPersonalCheckout({ ...input, projectId: standalone.id })).toThrow(
      expect.objectContaining({ code: "personal_project_required" }),
    );
    expect(data.findProjectById(standalone.id)?.personalMode).toBe(false);
  });
});

describe("portable participant identity", () => {
  it("requires explicit binding across independent local UUIDs without transferring credentials", () => {
    const sourceProject = project();
    const sourceAccount = person();
    const logicalId = data.ensureLocalParticipantIdentity(sourceProject.id, sourceAccount);
    expect(data.ensureLocalParticipantIdentity(sourceProject.id, sourceAccount)).toBe(logicalId);
    const portable = { projectId: sourceProject.id, id: logicalId, displayName: "Owner" };
    testDb.current.$client.close();
    testDb.current = createTestDb(); // Sequential unit fixture, not a concurrent two-node harness.
    testDb.current
      .insert(projects)
      .values({ id: sourceProject.id, name: "Project", rootPath: "mac-root", personalMode: true })
      .run();
    const targetAccount = person();
    data.recordLogicalParticipant(portable);
    expect(data.resolveLocalParticipant(sourceProject.id, logicalId)).toBeNull();
    expect(data.listLogicalParticipants(sourceProject.id)).toEqual([
      { ...portable, localParticipantId: null },
    ]);
    expect(data.listParticipants()).toHaveLength(1);
    data.bindLogicalParticipant({
      projectId: sourceProject.id,
      logicalParticipantId: logicalId,
      participantId: targetAccount,
    });
    expect(data.resolveLocalParticipant(sourceProject.id, logicalId)).toBe(targetAccount);
    expect(targetAccount).not.toBe(sourceAccount);
    expect(JSON.stringify(data.listLogicalParticipants(sourceProject.id))).not.toContain(
      "local-only-secret",
    );
    expect(data.findParticipantById(targetAccount)?.role).toBe("member");
    testDb.current
      .update(participants)
      .set({ active: false })
      .where(eq(participants.id, targetAccount))
      .run();
    expect(data.resolveLocalParticipant(sourceProject.id, logicalId)).toBeNull();
    expect(data.listLogicalParticipants(sourceProject.id)[0]?.displayName).toBe("Owner");
  });

  it("rejects missing, inactive and conflicting bindings without account-name inference", () => {
    const p = project();
    const first = person();
    const second = person();
    const inactive = person(crypto.randomUUID(), false);
    const id = crypto.randomUUID();
    expect(() =>
      data.bindLogicalParticipant({
        projectId: p.id,
        logicalParticipantId: id,
        participantId: first,
      }),
    ).toThrow(expect.objectContaining({ code: "identity_not_found" }));
    data.recordLogicalParticipant({ projectId: p.id, id, displayName: "Owner" });
    expect(data.resolveLocalParticipant(p.id, id)).toBeNull();
    expect(() =>
      data.bindLogicalParticipant({
        projectId: p.id,
        logicalParticipantId: id,
        participantId: inactive,
      }),
    ).toThrow(expect.objectContaining({ code: "participant_inactive" }));
    data.bindLogicalParticipant({
      projectId: p.id,
      logicalParticipantId: id,
      participantId: first,
    });
    expect(() =>
      data.bindLogicalParticipant({
        projectId: p.id,
        logicalParticipantId: id,
        participantId: second,
      }),
    ).toThrow(expect.objectContaining({ code: "identity_already_bound" }));
    expect(() => data.ensureLocalParticipantIdentity(p.id, inactive)).toThrow(
      expect.objectContaining({ code: "participant_inactive" }),
    );
  });
});
