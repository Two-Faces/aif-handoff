import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getEnv, resetEnvCache, tasks, PersonalExecutionDisabledError } from "@aif/shared";
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
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("personal execution policy", () => {
  it("persists local-only policy and pauses even explicitly auto-enabled new tasks", () => {
    const project = data.createProject({
      name: "personal",
      rootPath: "unused",
      personalMode: true,
    })!;
    expect(project).toMatchObject({
      personalMode: true,
      publicationPolicy: "local_only",
      autoQueueMode: false,
    });
    const task = data.createTask({
      projectId: project.id,
      title: "task",
      description: "",
      paused: false,
      autoMode: true,
    })!;
    expect(task).toMatchObject({ paused: true, autoMode: false });
    expect(data.isProjectPublicationAllowed(project.id)).toBe(false);
    expect(() => data.assertProjectExecutionAllowed(project.id)).toThrow(
      PersonalExecutionDisabledError,
    );
  });

  it("rejects all claims after unpause, auto-queue and externally changed task status", () => {
    const project = data.createProject({
      name: "personal",
      rootPath: "unused",
      personalMode: true,
    })!;
    const task = data.createTask({ projectId: project.id, title: "task", description: "" })!;
    data.updateTask(task.id, { paused: false, autoMode: true });
    data.setAutoQueueMode(project.id, true);
    expect(data.claimBacklogTaskForAdvance(task.id)).toBe(false);
    testDb.current.update(tasks).set({ status: "planning" }).where(eq(tasks.id, task.id)).run();
    expect(data.claimTask(task.id, "worker", 30_000)).toBe(false);
    expect(data.tryStartQaRun(task.id)).toBe(false);
    expect(data.tryStartQaCheckRun(task.id)).toBe(false);
    expect(data.findCoordinatorTaskCandidates("planner", 20)).toEqual([]);
    expect(data.findTaskById(task.id)?.lockedBy).toBeNull();
    expect(() => data.assertTaskExecutionAllowed(task.id)).toThrow(PersonalExecutionDisabledError);
  });

  it("does not trust a standalone project ID supplied with a personal task", () => {
    const personal = data.createProject({
      name: "personal",
      rootPath: "unused",
      personalMode: true,
    })!;
    const standalone = data.createProject({ name: "standalone", rootPath: "unused" })!;
    const task = data.createTask({ projectId: personal.id, title: "task", description: "" })!;
    expect(data.getPersonalExecutionBlock(standalone.id, task.id)?.code).toBe(
      "personal_execution_disabled",
    );
  });

  it("retains policy after disabling the onboarding env switch", () => {
    vi.stubEnv("AIF_PERSONAL_MODE", "true");
    resetEnvCache();
    expect(getEnv().AIF_PERSONAL_MODE).toBe(true);
    const project = data.createProject({ name: "personal", rootPath: "unused" })!;
    vi.stubEnv("AIF_PERSONAL_MODE", "false");
    resetEnvCache();
    expect(data.isPersonalProject(project.id)).toBe(true);
    expect(data.getPersonalExecutionBlock(project.id)?.code).toBe("personal_execution_disabled");
  });

  it("preserves standalone defaults, claims and publication", () => {
    const project = data.createProject({ name: "standalone", rootPath: "unused" })!;
    const task = data.createTask({ projectId: project.id, title: "task", description: "" })!;
    expect(task).toMatchObject({ paused: false, autoMode: true });
    expect(data.getPersonalExecutionBlock(project.id, task.id)).toBeNull();
    expect(data.isProjectPublicationAllowed(project.id)).toBe(true);
    expect(data.claimTask(task.id, "worker", 30_000)).toBe(true);
    expect(data.getPersonalExecutionBlock("missing")).toBeNull();
    expect(data.isPersonalTask("missing")).toBe(false);
  });
});
