import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb } from "@aif/shared/server";
import { resetEnvCache } from "@aif/shared";
import { UsageSource, initProject } from "@aif/runtime";

const testDb = { current: createTestDb() };
const roots: string[] = [];
vi.mock("@aif/shared/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aif/shared/server")>()),
  getDb: () => testDb.current,
}));
vi.mock("../ws.js", () => ({ broadcast: vi.fn(), sendToClient: vi.fn() }));
vi.mock("@aif/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aif/runtime")>()),
  initProject: vi.fn(() => {
    throw new Error("Unexpected initialization");
  }),
}));

const data = await import("@aif/data");
const { createProject: registerProject } = await import("../repositories/projects.js");
const { projectsRouter } = await import("../routes/projects.js");
const { tasksRouter } = await import("../routes/tasks.js");
const { chatRouter } = await import("../routes/chat.js");
const { githubRouter } = await import("../routes/github.js");
const { runCommitQuery } = await import("../services/commitGeneration.js");
const { runQaQuery } = await import("../services/qaRunner.js");
const { runQaCheckQuery } = await import("../services/qaCheckRunner.js");
const { runFastFixQuery } = await import("../services/fastFix.js");
const { generateRoadmapFile, generateRoadmapTasks } =
  await import("../services/roadmapGeneration.js");
const { runApiRuntimeOneShot } = await import("../services/runtime.js");

beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "true");
  resetEnvCache();
  testDb.current.$client.close();
  testDb.current = createTestDb();
  vi.mocked(initProject).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function personal(managed = false) {
  const project = data.createProject({
    name: "personal",
    rootPath: "nonexistent-root",
    personalMode: !managed,
  })!;
  const task = data.createTask({
    projectId: project.id,
    title: "task",
    description: "",
    paused: true,
  })!;
  if (managed) data.initializeTaskDeviceGrant(task.id);
  data.updateTask(task.id, { paused: false, autoMode: true });
  return { projectId: project.id, taskId: task.id, executionRoot: project.rootPath };
}

describe("personal project API", () => {
  it("blocks managed task helpers before Git, artifacts, runtime setup or unfenced error writes", async () => {
    const input = personal(true);
    for (const run of [runQaQuery, runQaCheckQuery, runCommitQuery]) {
      expect(await run(input)).toMatchObject({ ok: false, code: "run_scope_required" });
    }
    expect(await runCommitQuery({ projectId: input.projectId })).toMatchObject({
      ok: false,
      code: "taskless_execution_denied",
    });
    await expect(generateRoadmapFile(input)).rejects.toMatchObject({
      code: "taskless_execution_denied",
    });
    await expect(
      generateRoadmapTasks({ ...input, roadmapAlias: "example", trackingTaskId: input.taskId }),
    ).rejects.toMatchObject({ code: "run_scope_required" });
    await expect(
      runApiRuntimeOneShot({
        ...input,
        projectRoot: input.executionRoot,
        prompt: "edit",
        usageContext: { source: UsageSource.COMMIT },
      }),
    ).rejects.toMatchObject({ code: "run_scope_required" });
    await expect(
      runFastFixQuery({
        taskId: input.taskId,
        taskTitle: "task",
        taskDescription: "",
        latestComment: {
          author: "human",
          message: "fix",
          attachments: null,
          createdAt: "2026-10-02",
        },
        projectRoot: input.executionRoot,
        planPath: "PLAN.md",
        previousPlan: "",
      }),
    ).rejects.toMatchObject({ code: "run_scope_required" });
    expect(data.findTaskById(input.taskId)).toMatchObject({
      qaStatus: "idle",
      qaCheckStatus: "idle",
      lockedBy: null,
      sessionId: null,
    });
    expect(initProject).not.toHaveBeenCalled();
  });
  it("rejects mismatched or fabricated task IDs as a bypass for a managed project", async () => {
    const input = personal(true);
    const other = data.createProject({ name: "other", rootPath: "also-missing" })!;
    const task = data.createTask({ projectId: other.id, title: "other", description: "" })!;
    for (const taskId of [task.id, "not-a-task"]) {
      expect(await runCommitQuery({ projectId: input.projectId, taskId })).toMatchObject({
        code: "grant_missing",
      });
      await expect(
        runApiRuntimeOneShot({
          projectId: input.projectId,
          taskId,
          projectRoot: input.executionRoot,
          prompt: "edit",
          usageContext: { source: UsageSource.COMMIT },
        }),
      ).rejects.toMatchObject({ code: "grant_missing" });
    }
    expect(await runCommitQuery({ projectId: other.id, taskId: input.taskId })).toMatchObject({
      code: "run_fenced",
    });
  });
  it("rejects both task-bound and taskless managed chat before creating a session", async () => {
    const { projectId, taskId } = personal(true);
    const app = new Hono().route("/chat", chatRouter);
    for (const [body, code] of [
      [{ projectId, taskId, message: "resume" }, "run_scope_required"],
      [{ projectId, message: "edit files", explore: true }, "taskless_execution_denied"],
    ] as const) {
      const response = await app.request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(data.listChatSessions(projectId)).toEqual([]);
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeNull();
  });
  it("uses plan revisions through REST and handles board transitions without touching checkout", async () => {
    const { taskId } = personal();
    const app = new Hono().route("/tasks", tasksRouter);
    const send = (method: string, suffix: string, body: unknown) =>
      app.request(`/tasks/${taskId}${suffix}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const fetched = await app.request(`/tasks/${taskId}`);
    const task = await fetched.json();
    expect(task.syncRevisions.plan).toHaveLength(1);
    expect((await send("PUT", "", { plan: "Missing revision" })).status).toBe(409);
    const saved = await send("PUT", "", {
      plan: "Saved on board",
      expectedSyncRevisions: task.syncRevisions,
    });
    expect(saved.status).toBe(200);
    expect(
      (await send("PUT", "", { plan: "Stale", expectedSyncRevisions: task.syncRevisions })).status,
    ).toBe(409);
    const current = await saved.json();
    const accepted = await send("POST", "/events", {
      event: "accept_existing_plan",
      expectedSyncRevisions: current.syncRevisions,
    });
    expect(accepted.status).toBe(200);
    expect(data.findTaskById(taskId)?.status).toBe("plan_ready");
    for (const body of [{ event: "fast_fix" }, { event: "start_ai", deletePlanFile: true }]) {
      const result = await send("POST", "/events", body);
      expect(result.status).toBe(403);
      expect(await result.json()).toMatchObject({ code: "personal_execution_disabled" });
    }
    expect((await send("POST", "/sync-plan", {})).status).toBe(403);
  });
  it("attaches a dirty checkout without init or changing HEAD/index/context", async () => {
    const root = mkdtempSync(join(tmpdir(), "aif-personal-api-"));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(root, "AGENTS.md"), "original\n");
    git("add", "AGENTS.md");
    git("-c", "core.hooksPath=", "commit", "-m", "fixture");
    writeFileSync(join(root, "AGENTS.md"), "staged\n");
    git("add", "AGENTS.md");
    writeFileSync(join(root, "AGENTS.md"), "unstaged\n");
    writeFileSync(join(root, "untracked"), "keep\n");
    const index = readFileSync(join(root, ".git", "index"));
    const head = git("rev-parse", "HEAD");
    const app = new Hono().route("/projects", projectsRouter);
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Existing",
        rootPath: root,
        registrationMode: "attach_existing",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      personalMode: true,
      publicationPolicy: "local_only",
    });
    expect(initProject).not.toHaveBeenCalled();
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("unstaged\n");
    expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep\n");
  });

  it("rejects invalid attach and clone in personal mode before initialization", async () => {
    expect(
      await registerProject({
        name: "missing",
        rootPath: "does-not-exist",
        registrationMode: "attach_existing",
      }),
    ).toMatchObject({ ok: false, code: "invalid_git_checkout" });
    vi.stubEnv("AIF_PERSONAL_MODE", "true");
    resetEnvCache();
    expect(await registerProject({ name: "remote", githubRepository: "owner/repo" })).toMatchObject(
      { ok: false, code: "attach_existing_required" },
    );
    expect(initProject).not.toHaveBeenCalled();
    expect(data.listProjects()).toEqual([]);
  });

  it("blocks manual QA, warmup, roadmap and taskless/task chat before effects", async () => {
    const { projectId, taskId } = personal();
    const app = new Hono()
      .route("/projects", projectsRouter)
      .route("/tasks", tasksRouter)
      .route("/chat", chatRouter);
    for (const [path, body] of [
      [`/tasks/${taskId}/run-qa`, {}],
      [`/tasks/${taskId}/run-qa-check`, {}],
      [`/projects/${projectId}/warmup`, {}],
      [`/projects/${projectId}/roadmap/generate`, {}],
      ["/chat", { projectId, message: "edit files" }],
      ["/chat", { projectId, taskId, message: "resume and edit files" }],
    ] as const) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ code: "personal_execution_disabled" });
    }
    expect(data.findTaskById(taskId)).toMatchObject({
      lockedBy: null,
      qaStatus: "idle",
      qaCheckStatus: "idle",
    });
    expect(data.listChatSessions(projectId)).toEqual([]);
  });

  it("blocks direct helper calls, including mismatched project/task scope", async () => {
    const input = personal();
    for (const run of [runQaQuery, runQaCheckQuery]) {
      expect(await run(input)).toMatchObject({ ok: false, code: "personal_execution_disabled" });
    }
    expect(await runCommitQuery(input)).toMatchObject({
      ok: false,
      code: "personal_execution_disabled",
    });
    expect(await runCommitQuery({ projectId: input.projectId })).toMatchObject({
      ok: false,
      code: "personal_execution_disabled",
    });
    await expect(generateRoadmapFile(input)).rejects.toMatchObject({
      code: "personal_execution_disabled",
    });
    await expect(generateRoadmapTasks({ ...input, roadmapAlias: "example" })).rejects.toMatchObject(
      { code: "personal_execution_disabled" },
    );
    await expect(
      runFastFixQuery({
        taskId: input.taskId,
        taskTitle: "task",
        taskDescription: "",
        latestComment: {
          author: "human",
          message: "fix",
          attachments: null,
          createdAt: "2026-10-02",
        },
        projectRoot: input.executionRoot,
        planPath: "PLAN.md",
        previousPlan: "",
      }),
    ).rejects.toMatchObject({ code: "personal_execution_disabled" });
    await expect(
      runApiRuntimeOneShot({
        ...input,
        projectId: "other",
        projectRoot: input.executionRoot,
        prompt: "edit",
        usageContext: { source: UsageSource.COMMIT },
      }),
    ).rejects.toMatchObject({ code: "personal_execution_disabled" });
  });

  it("blocks direct PR publication even with the legacy GitHub flag enabled", async () => {
    const { projectId, taskId } = personal();
    const app = new Hono().route("/projects", githubRouter);
    const response = await app.request(`/projects/${projectId}/github/tasks/${taskId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feature/test", commitSha: "a".repeat(40) }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "local_publication_only" });
  });
});
