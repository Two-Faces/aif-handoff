import { describe, it, expect, vi } from "vitest";

const mockReleaseTaskClaim = vi.fn();
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

  releaseTaskClaim: (...args: unknown[]) => mockReleaseTaskClaim(...args),
}));

import {
  getActiveStageAbortController,
  setActiveStageAbortController,
  abortAllActiveStages,
} from "../stageAbort.js";

describe("stageAbort", () => {
  it("returns null when no controller is set", () => {
    setActiveStageAbortController("test-task", null);
    expect(getActiveStageAbortController("test-task")).toBeNull();
  });

  it("stores and retrieves an AbortController by taskId", () => {
    const abort = new AbortController();
    setActiveStageAbortController("task-1", abort);
    expect(getActiveStageAbortController("task-1")).toBe(abort);
    expect(getActiveStageAbortController("task-2")).toBeNull();
    setActiveStageAbortController("task-1", null);
  });

  it("supports multiple concurrent controllers", () => {
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    setActiveStageAbortController("task-1", abort1);
    setActiveStageAbortController("task-2", abort2);
    expect(getActiveStageAbortController("task-1")).toBe(abort1);
    expect(getActiveStageAbortController("task-2")).toBe(abort2);
    setActiveStageAbortController("task-1", null);
    setActiveStageAbortController("task-2", null);
  });

  it("returns single controller when no taskId given (backward compat)", () => {
    const abort = new AbortController();
    setActiveStageAbortController("task-1", abort);
    expect(getActiveStageAbortController()).toBe(abort);
    setActiveStageAbortController("task-1", null);
  });

  it("returns null when multiple controllers active and no taskId given", () => {
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    setActiveStageAbortController("task-1", abort1);
    setActiveStageAbortController("task-2", abort2);
    expect(getActiveStageAbortController()).toBeNull();
    setActiveStageAbortController("task-1", null);
    setActiveStageAbortController("task-2", null);
  });

  it("can abort the stored controller", () => {
    const abort = new AbortController();
    setActiveStageAbortController("task-1", abort);
    expect(abort.signal.aborted).toBe(false);

    abort.abort();
    expect(abort.signal.aborted).toBe(true);
    setActiveStageAbortController("task-1", null);
  });

  it("abortAllActiveStages aborts all controllers and releases locks", () => {
    mockReleaseTaskClaim.mockClear();
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    setActiveStageAbortController("task-1", abort1);
    setActiveStageAbortController("task-2", abort2);

    abortAllActiveStages();

    expect(abort1.signal.aborted).toBe(true);
    expect(abort2.signal.aborted).toBe(true);
    expect(getActiveStageAbortController("task-1")).toBeNull();
    expect(getActiveStageAbortController("task-2")).toBeNull();
    // Locks released for each active task
    expect(mockReleaseTaskClaim).toHaveBeenCalledWith("task-1");
    expect(mockReleaseTaskClaim).toHaveBeenCalledWith("task-2");
    expect(mockReleaseTaskClaim).toHaveBeenCalledTimes(2);
  });
});
