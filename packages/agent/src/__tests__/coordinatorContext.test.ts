import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { projects, tasks, resetEnvCache } from "@aif/shared";
import { createGitTestRoot } from "./gitTestUtils.js";

const db = createTestDb();
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db,
}));
vi.mock("@aif/runtime", async (original) => ({
  ...(await original<typeof import("@aif/runtime")>()),
  initProject: vi.fn(() => {
    throw new Error("Must not reinitialize the snapshot");
  }),
}));
vi.mock("../subagents/planner.js", () => ({ runPlanner: vi.fn().mockResolvedValue(undefined) }));
const { prepareTaskExecutionWorkspace } = await import("@aif/data");
const { RuntimeRegistry, initProject } = await import("@aif/runtime");
const { pollAndProcess, setRuntimeRegistry } = await import("../coordinator.js");
const { runPlanner } = await import("../subagents/planner.js");

describe("registered snapshot context", () => {
  it("passes its owned root to the planner without reinitializing existing AIF instructions", async () => {
    const fixture = createGitTestRoot("aif-coordinator-context-");
    const source = realpathSync.native(fixture.rootPath);
    const root = `${source}-task`;
    vi.stubEnv("AIF_PERSONAL_MODE", "false");
    resetEnvCache();
    try {
      db.insert(projects).values({ id: "project", name: "Context", rootPath: source }).run();
      db.insert(tasks)
        .values({
          id: "task",
          projectId: "project",
          title: "Plan",
          status: "planning",
          autoMode: false,
        })
        .run();
      prepareTaskExecutionWorkspace({
        projectId: "project",
        taskId: "task",
        projectRoot: source,
        worktreePath: root,
        snapshotCommit: fixture.initialSha,
      });
      const instructions = join(root, ".ai-factory", "DESCRIPTION.md");
      mkdirSync(dirname(instructions));
      writeFileSync(instructions, "Existing AIF 2.19 instructions\n");
      setRuntimeRegistry(new RuntimeRegistry());
      await pollAndProcess();
      expect(runPlanner).toHaveBeenCalledWith("task", root);
      expect(initProject).not.toHaveBeenCalled();
      expect(readFileSync(instructions, "utf8")).toBe("Existing AIF 2.19 instructions\n");
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
      rmSync(root, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
      db.$client.close();
    }
  }, 30_000);
});
