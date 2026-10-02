import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { resetEnvCache, taskDeviceRuns } from "@aif/shared";
import { UsageSource, type RuntimeRunInput, type RuntimeRunResult } from "@aif/runtime";

const state = vi.hoisted(() => ({
  run: vi.fn<(input: RuntimeRunInput) => Promise<RuntimeRunResult>>(),
  resume: vi.fn<(input: RuntimeRunInput) => Promise<RuntimeRunResult>>(),
}));
const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
vi.mock("../ws.js", () => ({ broadcast: vi.fn(), sendToClient: vi.fn() }));
vi.mock("@aif/runtime", async (original) => {
  const actual = await original<typeof import("@aif/runtime")>();
  return {
    ...actual,
    bootstrapRuntimeRegistry: async (
      options: Parameters<typeof actual.bootstrapRuntimeRegistry>[0],
    ) => {
      const registry = await actual.bootstrapRuntimeRegistry(options);
      const descriptor = registry.resolveRuntime("claude").descriptor;
      const capabilities = {
        ...descriptor.capabilities,
        usageReporting: actual.UsageReporting.NONE,
        supportsSessionList: false,
        supportsModelDiscovery: false,
      };
      registry.registerRuntime(
        {
          descriptor: { ...descriptor, capabilities },
          getEffectiveCapabilities: () => capabilities,
          run: state.run,
          resume: state.resume,
        },
        { replace: true },
      );
      return registry;
    },
  };
});
const data = await import("@aif/data");
const { runApiRuntimeOneShot } = await import("../services/runtime.js");
const { runCommitQuery } = await import("../services/commitGeneration.js");
const { generateRoadmapTasks } = await import("../services/roadmapGeneration.js");
const { chatRouter } = await import("../routes/chat.js");
const { tasksRouter } = await import("../routes/tasks.js");
const { resolveQaArtifactDir } = await import("../services/qaRunner.js");
const { sendToClient } = await import("../ws.js");
let directory: string;
let fixture: { taskId: string; projectId: string; source: string; checkout: string; head: string };
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
beforeEach(() => {
  for (const [key, value] of Object.entries({
    AIF_PERSONAL_MODE: "false",
    PARTICIPANTS_MODE_ENABLED: "false",
    AIF_DEFAULT_RUNTIME_ID: "claude",
    AIF_DEFAULT_PROVIDER_ID: "anthropic",
    AIF_WARMUP_ENABLED: "false",
    AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED: "false",
    AIF_USAGE_LIMITS_ENABLED: "false",
    AIF_GITHUB_ISSUE_PR_ENABLED: "false",
  }))
    vi.stubEnv(key, value);
  resetEnvCache();
  db.current.$client.close();
  db.current = createTestDb();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-api-lifecycle-")));
  const source = join(directory, "source"),
    checkout = join(directory, "checkout");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Lifecycle Fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "task.txt"), "base\n");
  mkdirSync(join(source, ".ai-factory"));
  writeFileSync(
    join(source, ".ai-factory", "ROADMAP.md"),
    "# Snapshot roadmap\n- [ ] Snapshot milestone\n",
  );
  git(source, "add", ".");
  git(source, "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const head = git(source, "rev-parse", "HEAD");
  const project = data.createProject({ name: "Lifecycle", rootPath: source })!;
  const task = data.createTask({
    projectId: project.id,
    title: "Task",
    description: "",
    paused: true,
  })!;
  data.prepareTaskExecutionWorkspace({
    projectId: project.id,
    taskId: task.id,
    projectRoot: source,
    worktreePath: checkout,
    snapshotCommit: head,
  });
  data.initializeTaskDeviceGrant(task.id);
  fixture = { taskId: task.id, projectId: project.id, source, checkout, head };
  state.run.mockReset().mockImplementation(async () => ({
    outputText: "Complete",
    sessionId: "native-session",
    usage: null,
  }));
  state.resume.mockReset().mockImplementation((input) => state.run(input));
  vi.mocked(sendToClient).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
const request = (app: Hono, body: unknown) =>
  app.request("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("managed API lifecycle with real DB and checkout", () => {
  it("rejects foreign, unbound and virtual sessions before reserving or invoking an adapter", async () => {
    const { taskId, projectId } = fixture;
    const app = new Hono().route("/chat", chatRouter);
    const first = await request(app, { projectId, taskId, message: "Start" });
    expect(first.status).toBe(200);
    const { sessionId } = await first.json();
    const unbound = data.createChatSession({ projectId, title: "Unbound" });
    if (!unbound) throw new Error("Expected unbound chat fixture");
    const other = data.createTask({ projectId, title: "Other", description: "", paused: true })!;
    for (const body of [
      { projectId, taskId: other.id, sessionId },
      { projectId, sessionId },
      { projectId, taskId, sessionId: unbound.id },
      { projectId, sessionId: "sdk:native-session" },
    ]) {
      const response = await request(app, { ...body, message: "Invalid resume" });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ code: "run_session_mismatch" });
    }
    const protectedWrite = await app.request(`/chat/sessions/${sessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeSessionId: "fabricated" }),
    });
    expect(protectedWrite.status).toBe(409);
    const renamed = await app.request(`/chat/sessions/${sessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(renamed.status).toBe(200);
    expect(data.findChatSessionById(sessionId)?.runtimeSessionId).toBe("native-session");
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeNull();
    expect(db.current.select().from(taskDeviceRuns).all()).toHaveLength(1);
    expect(state.run).toHaveBeenCalledTimes(1);
    expect(state.resume).not.toHaveBeenCalled();
  });
  it("reads roadmap input from the registered snapshot while the source checkout has different content", async () => {
    const { taskId, projectId, source, checkout } = fixture;
    writeFileSync(join(source, ".ai-factory", "ROADMAP.md"), "# Unrelated source edits\n");
    state.run.mockImplementation(async (input) => {
      expect(input.projectRoot).toBe(checkout);
      expect(input.prompt).toContain("Snapshot milestone");
      expect(input.prompt).not.toContain("Unrelated source edits");
      return {
        usage: null,
        outputText: JSON.stringify({
          alias: "fixture",
          tasks: [{ title: "Snapshot task", phase: 1, sequence: 1 }],
        }),
      };
    });
    expect(
      await generateRoadmapTasks({ projectId, trackingTaskId: taskId, roadmapAlias: "fixture" }),
    ).toMatchObject({ tasks: [{ title: "Snapshot task" }] });
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeNull();
  });
  it("holds a background QA job through artifact persistence and clears only its own claim", async () => {
    vi.stubEnv("AIF_QA_PIPELINE_ENABLED", "true");
    resetEnvCache();
    const { taskId, checkout } = fixture;
    let finish!: (value: RuntimeRunResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    state.run.mockImplementation(async (input) => {
      expect(input.projectRoot).toBe(checkout);
      return new Promise((resolve) => {
        finish = resolve;
        entered();
      });
    });
    const app = new Hono().route("/tasks", tasksRouter);
    const accepted = await app.request(`/tasks/${taskId}/run-qa`, { method: "POST" });
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    await started;
    const runId = data.getTaskDeviceGrant(taskId)!.activeRunId!;
    expect(data.findTaskById(taskId)).toMatchObject({ qaStatus: "running" });
    const repeated = await app.request(`/tasks/${taskId}/run-qa`, { method: "POST" });
    expect(repeated.status).toBe(409);
    const { artifactDir } = resolveQaArtifactDir(null, checkout);
    mkdirSync(artifactDir, { recursive: true });
    for (const name of ["change-summary.md", "test-plan.md", "test-cases.md"])
      writeFileSync(join(artifactDir, name), `# ${name}\nReady\n`);
    finish({ usage: null, outputText: "QA complete" });
    await vi.waitFor(() => expect(data.getTaskDeviceRun(runId)?.state).toBe("settled"));
    expect(data.findTaskById(taskId)).toMatchObject({ qaStatus: "done", lockedBy: null });
    expect(data.findTaskById(taskId)?.qaTestCases).toContain("Ready");
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeNull();
    expect(state.run).toHaveBeenCalledTimes(1);
  });
  it("runs one-shot and chat/resume in the exact checkout and settles only after session writes", async () => {
    const { taskId, projectId, source, checkout } = fixture;
    const result = await runApiRuntimeOneShot({
      taskId,
      projectId,
      projectRoot: source,
      prompt: "fixture",
      usageContext: { source: UsageSource.COMMIT },
    });
    expect(result.result.outputText).toBe("Complete");
    expect(state.run.mock.calls[0][0]).toMatchObject({ projectRoot: checkout, cwd: checkout });
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeNull();
    const app = new Hono().route("/chat", chatRouter);
    const first = await request(app, {
      projectId,
      taskId,
      message: "First",
      attachments: [{ name: "context.txt", mimeType: "text/plain", size: 7, content: "context" }],
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.assistantMessage).toBe("Complete");
    const attachment = await app.request(
      `/chat/sessions/${firstBody.sessionId}/attachments/context.txt`,
    );
    expect(attachment.status).toBe(200);
    expect(await attachment.text()).toBe("context");
    const second = await request(app, {
      projectId,
      taskId,
      message: "Continue",
      sessionId: firstBody.sessionId,
      conversationId: firstBody.conversationId,
    });
    expect(second.status).toBe(200);
    expect(state.resume).toHaveBeenCalledTimes(1);
    expect(state.resume.mock.calls[0][0]).toMatchObject({
      projectRoot: checkout,
      cwd: checkout,
      sessionId: "native-session",
    });
    expect(
      data.listChatMessages(firstBody.sessionId).filter((message) => message.role === "assistant"),
    ).toHaveLength(2);
    expect(
      db.current
        .select()
        .from(taskDeviceRuns)
        .all()
        .map((row) => row.state),
    ).toEqual(["settled", "settled", "settled"]);
    expect(git(source, "rev-parse", "HEAD")).toBe(fixture.head);
  });
  it("fences a cancelled chat, drops late events/output and refuses a second launch", async () => {
    const { taskId, projectId } = fixture;
    let finish!: (value: RuntimeRunResult) => void;
    let input!: RuntimeRunInput;
    state.run.mockImplementation(async (value) => {
      input = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const app = new Hono().route("/chat", chatRouter);
    const conversationId = crypto.randomUUID();
    const running = request(app, {
      projectId,
      taskId,
      conversationId,
      clientId: "fixture",
      message: "Start",
    });
    await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(1));
    const runId = data.getTaskDeviceGrant(taskId)!.activeRunId!;
    const stopped = await app.request(`/chat/${conversationId}/abort`, { method: "POST" });
    expect(stopped.status).toBe(204);
    expect(input.execution?.abortController?.signal.aborted).toBe(true);
    expect(data.getTaskDeviceRun(runId)?.state).toBe("uncertain");
    const eventsBefore = vi.mocked(sendToClient).mock.calls.length;
    expect(() =>
      input.execution?.onEvent?.({
        type: "stream:text",
        message: "Late",
        timestamp: new Date().toISOString(),
      }),
    ).not.toThrow();
    expect(vi.mocked(sendToClient).mock.calls.length).toBe(eventsBefore);
    finish({ usage: null, outputText: "Late answer", sessionId: "late-session" });
    const response = await running;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "run_fenced" });
    const sessions = data.listChatSessions(projectId);
    expect(sessions).toHaveLength(1);
    expect(
      data.listChatMessages(sessions[0].id).filter((message) => message.role === "assistant"),
    ).toEqual([]);
    expect(sessions[0].runtimeSessionId).toBeNull();
    const retry = await request(app, { projectId, taskId, message: "Retry" });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: "run_busy" });
    expect(state.run).toHaveBeenCalledTimes(1);
  });
  it("checkpoints code without an AI commit call or changing the source checkout", async () => {
    const { taskId, projectId, source, checkout } = fixture;
    writeFileSync(join(checkout, "task.txt"), "scoped change\n");
    expect(await runCommitQuery({ taskId, projectId })).toMatchObject({ ok: true });
    expect(state.run).not.toHaveBeenCalled();
    expect(data.getTaskExecutionWorkspace(taskId)?.state).toBe("checkpointed");
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeNull();
    expect(readFileSync(join(source, "task.txt"), "utf8")).toBe("base\n");
    expect(git(source, "rev-parse", "HEAD")).toBe(fixture.head);
  });
});
