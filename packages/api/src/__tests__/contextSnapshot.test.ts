import { describe, expect, it } from "vitest";
import {
  continuationNotesSchema,
  makeCodeSnapshotPackage,
  snapshotDigest,
  type ContextManifest,
} from "@aif/shared";
import { renderSnapshotContinuation } from "../services/contextSnapshot.js";

describe("snapshot continuation prompt", () => {
  it("renders verified project context for a new local session without executing check commands", () => {
    const context: ContextManifest = {
      version: 1,
      projectId: "project",
      taskId: "task",
      commitSha: "a".repeat(40),
      notes: continuationNotesSchema.parse({
        goal: "Finish the task",
        nextStep: "Inspect the previous check",
        checks: [
          {
            command: "never-execute-this-command",
            outcome: "not_run",
            summary: "Manual next step",
          },
        ],
      }),
      plan: { text: "# Existing plan", revision: snapshotDigest({ text: "# Existing plan" }) },
      files: [],
    };
    const pack = makeCodeSnapshotPackage(
      {
        version: 1,
        projectId: context.projectId,
        taskId: context.taskId,
        sourceDeviceId: "74870384-2979-43dc-bb16-299c7f7b3152",
        commitSha: context.commitSha,
        baseCommit: context.commitSha,
        objectFormat: "sha1",
        branchLabel: null,
        parentSnapshotId: null,
        contextDigest: snapshotDigest(context),
      },
      context,
      [],
    );
    const prompt = renderSnapshotContinuation(pack);
    expect(prompt).toContain(`Snapshot: ${pack.id}`);
    expect(prompt).toContain("Start a new local session");
    expect(prompt).toContain("Execution requires local authorization");
    expect(prompt).toContain("never-execute-this-command");
    expect(prompt).toContain("# Existing plan");
    expect(() => renderSnapshotContinuation({ ...pack, id: "b".repeat(64) })).toThrow();
  });
});
