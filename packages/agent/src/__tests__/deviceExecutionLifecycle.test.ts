import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/shared/server";
import { resetEnvCache, taskDeviceRuns, tasks } from "@aif/shared";
import {
  createRuntimeWorkflowSpec,
  type RuntimeRunInput,
  type RuntimeRunResult,
} from "@aif/runtime";

const state = vi.hoisted(() => ({
  run: vi.fn<(input: RuntimeRunInput) => Promise<RuntimeRunResult>>(),
  resume: vi.fn<(input: RuntimeRunInput) => Promise<RuntimeRunResult>>(),
}));
const db = { current: createTestDb() };
vi.mock("@aif/shared/server", async (original) => ({
  ...(await original<typeof import("@aif/shared/server")>()),
  getDb: () => db.current,
}));
vi.mock("../notifier.js", () => ({
  notifyTaskBroadcast: vi.fn(async () => {}),
  notifyProjectBroadcast: vi.fn(async () => {}),
  notifyProjectRuntimeLimitBroadcast: vi.fn(async () => {}),
}));
vi.mock("../queryAudit.js", () => ({ writeQueryAudit: vi.fn() }));
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
import { eq } from "drizzle-orm";
const data = await import("@aif/data");
vi.stubEnv("AGENT_STAGE_RUN_TIMEOUT_MS", "60000");
vi.stubEnv("AGENT_FIRST_ACTIVITY_TIMEOUT_MS", "0");
resetEnvCache();
const { pollAndProcess, getActivePollCycleCount, getStageSemaphore } =
  await import("../coordinator.js");
const { executeSubagentQuery } = await import("../subagentQuery.js");
const { logActivity, flushActivityQueue, disposeActivityQueue } = await import("../hooks.js");
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
    AGENT_FIRST_ACTIVITY_TIMEOUT_MS: "0",
  }))
    vi.stubEnv(key, value);
  resetEnvCache();
  db.current.$client.close();
  db.current = createTestDb();
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-agent-lifecycle-")));
  const source = join(directory, "source"),
    checkout = join(directory, "checkout");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Lifecycle Fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "task.txt"), "base\n");
  writeFileSync(join(source, "PLAN.md"), "# Plan\n- [ ] Implement fixture\n- [ ] Check fixture\n");
  git(source, "add", "task.txt", "PLAN.md");
  git(source, "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const head = git(source, "rev-parse", "HEAD");
  const project = data.createProject({ name: "Lifecycle", rootPath: source })!;
  const task = data.createTask({
    projectId: project.id,
    title: "Task",
    description: "",
    paused: true,
  })!;
  data.updateTask(task.id, {
    useSubagents: false,
    autoMode: false,
    plan: "# Plan\n- [ ] Implement fixture\n- [ ] Check fixture\n",
    planPath: "PLAN.md",
  });
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
});
afterEach(() => {
  disposeActivityQueue(fixture.taskId);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
describe("managed worker lifecycle with real DB and checkout", () => {
  it("keeps one coordinator run through stage execution, plan persistence and status completion", async () => {
    const { taskId, source, checkout } = fixture;
    db.current
      .update(tasks)
      .set({ status: "improve", paused: false })
      .where(eq(tasks.id, taskId))
      .run();
    state.run.mockImplementation(async (input) => {
      expect(input.projectRoot).toBe(checkout);
      expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeTruthy();
      writeFileSync(
        join(checkout, "PLAN.md"),
        "# Plan\n- [ ] Implement fixture\n- [ ] Check fixture\n- [ ] Added review\n",
      );
      return { usage: null, outputText: "Improved", sessionId: "worker-session" };
    });
    await pollAndProcess();
    expect(state.run).toHaveBeenCalledTimes(1);
    expect(data.findTaskById(taskId)).toMatchObject({ status: "plan_ready", lockedBy: null });
    expect(data.findTaskById(taskId)?.plan).toContain("Added review");
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeNull();
    expect(
      db.current
        .select()
        .from(taskDeviceRuns)
        .all()
        .map((row) => row.state),
    ).toEqual(["settled"]);
    expect(readFileSync(join(source, "PLAN.md"), "utf8")).not.toContain("Added review");
    expect(git(source, "rev-parse", "HEAD")).toBe(fixture.head);
  });
  it("retains a timed-out coordinator run and refuses retries or late stage completion", async () => {
    const { taskId } = fixture;
    db.current
      .update(tasks)
      .set({ status: "improve", paused: false })
      .where(eq(tasks.id, taskId))
      .run();
    vi.useFakeTimers();
    let finish!: (value: RuntimeRunResult) => void;
    let input!: RuntimeRunInput;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    state.run.mockImplementation(async (value) => {
      input = value;
      return new Promise((resolve) => {
        finish = resolve;
        entered();
      });
    });
    expect(data.findCoordinatorTaskCandidates("improver", 1).map((task) => task.id)).toEqual([
      taskId,
    ]);
    expect(getActivePollCycleCount()).toBe(0);
    expect(getStageSemaphore().totalActive()).toBe(0);
    const processing = pollAndProcess();
    await started;
    expect(state.run).toHaveBeenCalledTimes(1);
    const runId = data.getTaskDeviceGrant(taskId)!.activeRunId!;
    await vi.advanceTimersByTimeAsync(60001);
    await processing;
    expect(input.execution?.abortController?.signal.aborted).toBe(true);
    expect(data.getTaskDeviceRun(runId)?.state).toBe("uncertain");
    db.current.update(tasks).set({ lockedUntil: "2000-01-01" }).where(eq(tasks.id, taskId)).run();
    await pollAndProcess();
    expect(state.run).toHaveBeenCalledTimes(1);
    expect(() =>
      input.execution?.onEvent?.({
        type: "stream:text",
        message: "Late",
        timestamp: new Date().toISOString(),
      }),
    ).not.toThrow();
    finish({ usage: null, outputText: "Late result", sessionId: "late-session" });
    await vi.advanceTimersByTimeAsync(0);
    expect(data.findTaskById(taskId)).toMatchObject({ status: "improve", sessionId: null });
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBe(runId);
  });
  it("fences direct resume through the same lifecycle and saves only its current session", async () => {
    const { taskId, source, checkout } = fixture;
    vi.stubEnv("AIF_WARMUP_ENABLED", "true");
    resetEnvCache();
    const warmupLookup = vi.spyOn(data, "findActiveReadyRuntimeWarmupSession");
    const workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "fixture",
      sessionReusePolicy: "resume_if_available",
    });
    await executeSubagentQuery({
      taskId,
      projectRoot: source,
      agentName: "fixture",
      prompt: "fixture",
      workflowSpec,
    });
    await executeSubagentQuery({
      taskId,
      projectRoot: source,
      agentName: "fixture",
      prompt: "fixture",
      workflowSpec,
    });
    expect(state.resume).toHaveBeenCalledTimes(1);
    expect(state.resume.mock.calls[0][0]).toMatchObject({
      cwd: checkout,
      projectRoot: checkout,
      sessionId: "native-session",
    });
    expect(data.findTaskById(taskId)?.sessionId).toBe("native-session");
    expect(data.getTaskDeviceGrant(taskId)?.activeRunId).toBeNull();
    expect(warmupLookup).not.toHaveBeenCalled();
    warmupLookup.mockRestore();
  });
  it("does not adopt a completed run's buffered activity into the next run", async () => {
    const { taskId, source } = fixture;
    vi.stubEnv("ACTIVITY_LOG_MODE", "batch");
    resetEnvCache();
    await data.withProjectDeviceExecution({ taskId, projectRoot: source }, async () =>
      logActivity(taskId, "Agent", "old buffered activity"),
    );
    await data.withProjectDeviceExecution({ taskId, projectRoot: source }, async () => {
      logActivity(taskId, "Agent", "current activity");
      flushActivityQueue(taskId);
    });
    expect(data.findTaskById(taskId)?.agentActivityLog).toContain("current activity");
    expect(data.findTaskById(taskId)?.agentActivityLog).not.toContain("old buffered activity");
  });
});
