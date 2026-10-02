import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { resetEnvCache } from "@aif/shared";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aif/shared/server")>()),
  getDb: () => testDb.current,
}));

const data = await import("@aif/data");
const { runPlanner } = await import("../subagents/planner.js");
const { runImplementer } = await import("../subagents/implementer.js");
const { runImprover } = await import("../subagents/improver.js");
const { runPlanChecker } = await import("../subagents/planChecker.js");
const { runReviewer } = await import("../subagents/reviewer.js");
const { runVerifier } = await import("../subagents/verifier.js");
const { ensureAutoQueueTaskCommit } = await import("../autoQueueCommit.js");
const { publishGitHubTask } = await import("../githubWorkflow.js");
const { processAutoQueueAdvance, processDueScheduledTasks } = await import("../coordinator.js");

beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "true");
  resetEnvCache();
  testDb.current.$client.close();
  testDb.current = createTestDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

function personal() {
  const project = data.createProject({
    name: "personal",
    rootPath: "missing-checkout",
    personalMode: true,
  })!;
  const task = data.createTask({
    projectId: project.id,
    title: "task",
    description: "",
    scheduledAt: "2020-01-01T00:00:00.000Z",
  })!;
  data.updateTask(task.id, { paused: false, autoMode: true });
  data.setAutoQueueMode(project.id, true);
  return { project, task };
}

describe("personal worker execution denial", () => {
  it.each([runPlanner, runImplementer, runImprover, runPlanChecker, runReviewer, runVerifier])(
    "blocks a direct stage entry before checkout preparation (%#)",
    async (runner) => {
      const { task, project } = personal();
      await expect(runner(task.id, project.rootPath)).rejects.toMatchObject({
        code: "personal_execution_disabled",
      });
      expect(data.findTaskById(task.id)?.lockedBy).toBeNull();
    },
  );

  it("does not advance due tasks or auto-queue even after flags were enabled", () => {
    const { task } = personal();
    expect(processAutoQueueAdvance()).toBe(0);
    expect(processDueScheduledTasks()).toBe(0);
    expect(data.findTaskById(task.id)?.status).toBe("backlog");
  });

  it("denies commit preparation and legacy GitHub publication", async () => {
    const { task, project } = personal();
    await expect(
      ensureAutoQueueTaskCommit({ taskId: task.id, projectRoot: project.rootPath }),
    ).rejects.toMatchObject({ code: "personal_execution_disabled" });
    expect(await publishGitHubTask(task.id, project.rootPath)).toBe(false);
  });
});
