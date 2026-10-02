import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunApiRuntimeOneShot = vi.fn();
const mockFindProjectById = vi.fn();
const mockFindTaskById = vi.fn();
const mockGetProjectConfig = vi.fn();
const mockRestorePersistedBranch = vi.fn();
const mockAssertCurrentBranch = vi.fn();
const mockGetWorkspace = vi.fn();
const mockCheckpoint = vi.fn();

vi.mock("../services/runtime.js", () => ({
  runApiRuntimeOneShot: (...args: unknown[]) => mockRunApiRuntimeOneShot(...args),
}));

vi.mock("@aif/data", () => ({
  getPersonalExecutionBlock: vi.fn(() => null),
  getDeviceExecutionBlock: vi.fn(() => null),
  isProjectPublicationAllowed: vi.fn(() => true),
  getTaskExecutionWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
  checkpointTaskExecutionWorkspace: (...args: unknown[]) => mockCheckpoint(...args),
  findProjectById: (id: string) => mockFindProjectById(id),
  findTaskById: (id: string) => mockFindTaskById(id),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    restorePersistedBranch: (...args: unknown[]) => mockRestorePersistedBranch(...args),
    getProjectConfig: (...args: unknown[]) => mockGetProjectConfig(...args),
    assertCurrentBranch: (...args: unknown[]) => mockAssertCurrentBranch(...args),
  };
});

const { runCommitQuery, buildCommitPrompt } = await import("../services/commitGeneration.js");

function gitConfig(skipPush: boolean) {
  return {
    git: {
      enabled: true,
      base_branch: "main",
      create_branches: true,
      branch_prefix: "feature/",
      skip_push_after_commit: skipPush,
    },
  };
}

describe("buildCommitPrompt", () => {
  it("uses only the staged selection and includes push instruction when shouldPush=true", () => {
    const prompt = buildCommitPrompt(true);
    expect(prompt).toContain("already staged by the user");
    expect(prompt).not.toContain("git add -A");
    expect(prompt).toContain("git push");
    expect(prompt).not.toMatch(/Do NOT push/i);
  });

  it("uses only the staged selection and explicit no-push when shouldPush=false", () => {
    const prompt = buildCommitPrompt(false);
    expect(prompt).toContain("already staged by the user");
    expect(prompt).not.toContain("git add -A");
    expect(prompt).toMatch(/Do NOT push/i);
    expect(prompt).toContain("skip_push_after_commit");
  });

  it("forbids --no-verify, amend, and Co-Authored-By", () => {
    const prompt = buildCommitPrompt(true);
    expect(prompt).toContain("--no-verify");
    expect(prompt).toContain("amend");
    expect(prompt).toContain("Co-Authored-By");
  });
});

describe("runCommitQuery", () => {
  beforeEach(() => {
    mockRunApiRuntimeOneShot.mockReset();
    mockFindProjectById.mockReset();
    mockFindTaskById.mockReset();
    mockGetProjectConfig.mockReset();
    mockRestorePersistedBranch.mockReset();
    mockAssertCurrentBranch.mockReset();
    mockGetWorkspace.mockReset();
    mockCheckpoint.mockReset();
    mockFindProjectById.mockReturnValue({ id: "p1", rootPath: "/tmp/p1" });
    mockFindTaskById.mockReturnValue(null);
  });

  it("returns ok:false when project not found", async () => {
    mockFindProjectById.mockReturnValue(undefined);
    const res = await runCommitQuery({ projectId: "missing" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Project not found/);
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
  });

  it("uses the durable checkpoint for registered tasks without runtime or publication", async () => {
    mockFindTaskById.mockReturnValue({
      id: "t1",
      title: "Owned change",
      executionOwner: "ai",
      branchName: null,
      worktreePath: "/tmp/task",
    });
    mockGetWorkspace.mockReturnValue({ taskId: "t1" });
    mockCheckpoint.mockReturnValue({ status: "committed", commitSha: "a".repeat(40) });
    expect(await runCommitQuery({ projectId: "p1", taskId: "t1" })).toEqual({ ok: true });
    expect(mockCheckpoint).toHaveBeenCalledWith("t1", "chore: checkpoint Owned change");
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
    expect(mockRestorePersistedBranch).not.toHaveBeenCalled();
    expect(mockGetProjectConfig).not.toHaveBeenCalled();
    mockCheckpoint.mockImplementationOnce(() => {
      throw new Error("Checkpoint requires recovery");
    });
    expect(await runCommitQuery({ projectId: "p1", taskId: "t1" })).toEqual({
      ok: false,
      error: "Checkpoint requires recovery",
    });
  });

  it("rejects commit generation for a human-owned task", async () => {
    mockFindTaskById.mockReturnValue({
      id: "t1",
      executionOwner: "human",
      branchName: null,
      isFix: false,
    });
    const res = await runCommitQuery({ projectId: "p1", taskId: "t1" });
    expect(res).toMatchObject({ ok: false, code: "ai_handoff_required" });
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
  });

  it("sends push-enabled prompt when skip_push_after_commit=false", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(false));
    mockRunApiRuntimeOneShot.mockResolvedValue({ result: { outputText: "ok" }, context: {} });
    const res = await runCommitQuery({ projectId: "p1", taskId: "t1" });
    expect(res.ok).toBe(true);
    expect(mockRunApiRuntimeOneShot).toHaveBeenCalledTimes(1);
    const callArg = mockRunApiRuntimeOneShot.mock.calls[0][0];
    expect(callArg.workflowKind).toBe("commit");
    expect(callArg.fallbackSlashCommand).toBe("/aif-commit");
    expect(callArg.prompt).toContain("already staged by the user");
    expect(callArg.prompt).not.toContain("git add -A");
    expect(callArg.prompt).toContain("git push");
    expect(callArg.prompt).not.toMatch(/Do NOT push/i);
  });

  it("restores persisted task branch via restorePersistedBranch before commit runtime starts", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(false));
    mockFindTaskById.mockReturnValue({
      id: "t1",
      title: "Task title",
      branchName: "feature/task-title-t1",
      isFix: false,
    });
    mockRunApiRuntimeOneShot.mockResolvedValue({ result: { outputText: "ok" }, context: {} });

    const res = await runCommitQuery({ projectId: "p1", taskId: "t1" });

    expect(res.ok).toBe(true);
    expect(mockRestorePersistedBranch).toHaveBeenCalledWith({
      projectRoot: "/tmp/p1",
      taskId: "t1",
      persistedBranchName: "feature/task-title-t1",
    });
    expect(mockRestorePersistedBranch.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunApiRuntimeOneShot.mock.invocationCallOrder[0],
    );
  });

  it("returns ok:false fail-closed when restorePersistedBranch throws (e.g. git_disabled_with_persisted_branch)", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(false));
    mockFindTaskById.mockReturnValue({
      id: "t1",
      title: "Task title",
      branchName: "feature/task-title-t1",
      isFix: false,
    });
    mockRestorePersistedBranch.mockImplementation(() => {
      throw new Error("Branch isolation: config drift, git.enabled=false");
    });

    const res = await runCommitQuery({ projectId: "p1", taskId: "t1" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/config drift/);
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
  });

  it("sends no-push prompt when skip_push_after_commit=true", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(true));
    mockRunApiRuntimeOneShot.mockResolvedValue({ result: { outputText: "ok" }, context: {} });
    const res = await runCommitQuery({ projectId: "p1" });
    expect(res.ok).toBe(true);
    const callArg = mockRunApiRuntimeOneShot.mock.calls[0][0];
    expect(callArg.prompt).toMatch(/Do NOT push/i);
    expect(callArg.prompt).not.toMatch(/\brun `git push`/);
  });

  it("returns ok:false with error message when runtime throws", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(false));
    mockRunApiRuntimeOneShot.mockRejectedValue(new Error("boom"));
    const res = await runCommitQuery({ projectId: "p1" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });

  it("returns ok:false when subagent switched HEAD to a different branch (post-run drift)", async () => {
    mockGetProjectConfig.mockReturnValue(gitConfig(false));
    mockFindTaskById.mockReturnValue({
      id: "t1",
      title: "Task title",
      branchName: "feature/task-title-t1",
      isFix: false,
    });
    mockRunApiRuntimeOneShot.mockResolvedValue({ result: { outputText: "ok" }, context: {} });
    mockAssertCurrentBranch.mockImplementation(() => {
      throw new Error(
        "Branch drift detected: expected HEAD=feature/task-title-t1, actual HEAD=main.",
      );
    });

    const res = await runCommitQuery({ projectId: "p1", taskId: "t1" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Branch drift detected/);
    expect(mockAssertCurrentBranch).toHaveBeenCalledWith("/tmp/p1", "feature/task-title-t1");
    expect(mockAssertCurrentBranch.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockRunApiRuntimeOneShot.mock.invocationCallOrder[0],
    );
  });
});
