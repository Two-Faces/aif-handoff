import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listRepositoriesMock = vi.fn();
const findGitHubIssueMock = vi.fn();
const getWorkspaceMock = vi.fn();

vi.mock("@aif/data", () => ({
  // These unit fixtures model unmanaged tasks; managed lifecycles use real-DB tests.
  recordTaskDeviceNativeSession: () => {},
  recordTaskDeviceRuntimeEvent: () => {},
  canResumeTaskDeviceSession: () => true,
  assertTaskDeviceChatSession: () => {},
  assertTaskDeviceChatProject: () => {},
  withProjectDeviceExecution: (
    input: { projectRoot?: string },
    execute: (root?: string) => unknown,
  ) => execute(input.projectRoot),
  createTaskDeviceRuntimeGuard: (
    _taskId?: string | null,
    abortController = new AbortController(),
  ) => ({
    managed: false,
    abortController,
    assertCurrent: () => {},
    bind: <T>(callback: T) => callback,
    run: (execute: () => unknown) => execute(),
  }),
  invalidateTaskDeviceExecution: () => false,
  bindTaskDeviceExecution: <T>(callback: T) => callback,
  currentTaskDeviceRunId: () => null,

  isProjectPublicationAllowed: vi.fn(() => true),
  getTaskExecutionWorkspace: (...args: unknown[]) => getWorkspaceMock(...args),
  appendTaskActivityLog: vi.fn(),
  findGitHubIssueByTaskId: (...args: unknown[]) => findGitHubIssueMock(...args),
  findTaskById: vi.fn(),
  listEnabledGitHubRepositories: (...args: unknown[]) => listRepositoriesMock(...args),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return { ...actual, getEnv: () => actual.validateEnv(process.env) };
});

vi.mock("../autoQueueCommit.js", () => ({ ensureAutoQueueTaskCommit: vi.fn() }));

const { synchronizeGitHubProjects, publishGitHubTask } = await import("../githubWorkflow.js");

describe("GitHub workflow synchronization", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
    vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "true");
    listRepositoriesMock.mockClear();
    findGitHubIssueMock.mockClear();
    getWorkspaceMock.mockReset();
    listRepositoriesMock.mockReturnValue([
      { projectId: "project-1", lastSyncedAt: null },
      { projectId: "project-2", lastSyncedAt: "2026-08-08T09:59:40.000Z" },
    ]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("syncs due repositories once per interval", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await synchronizeGitHubProjects(Date.parse("2026-08-08T10:00:00.000Z"));
    await synchronizeGitHubProjects(Date.parse("2026-08-08T10:00:10.000Z"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3999/projects/project-1/github/sync",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("never publishes a registered local checkpoint workspace", async () => {
    getWorkspaceMock.mockReturnValue({ taskId: "task" });
    global.fetch = vi.fn();
    expect(await publishGitHubTask("task", "/unused-source")).toBe(false);
    expect(findGitHubIssueMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not inspect repositories or call GitHub paths while the rollout flag is disabled", async () => {
    vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "false");
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    await synchronizeGitHubProjects(Date.parse("2026-08-08T11:00:00.000Z"));

    expect(listRepositoriesMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
