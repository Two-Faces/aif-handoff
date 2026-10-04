import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createProject,
  createTask,
  getTaskExecutionWorkspace,
  prepareTaskExecutionWorkspace,
  prepareTaskWorkspaceCheckpoint,
  publishTaskWorkspaceCheckpoint,
  assertTaskExecutionAllowed,
  captureTaskCodeSnapshot,
  beginTaskWorkspaceContinuation,
  activateTaskWorkspaceContinuation,
  loadCodeSnapshotPackage,
} from "../../index.js";
import {
  continuationNotesSchema,
  getHeadCommitSha,
  installContextSnapshot,
  prepareTaskCheckout,
  publishTaskCommit,
  restoreTaskCommitIntent,
} from "@aif/shared";

const [mode, directory] = process.argv.slice(2);
const idsPath = join(directory, "ids.json");
if (mode === "initialize") {
  const source = join(directory, "source");
  const project = createProject({ name: "Recovery fixture", rootPath: source });
  if (!project) throw new Error("Missing project");
  const task = createTask({
    projectId: project.id,
    title: "Recover checkpoint",
    description: "",
    paused: true,
    autoMode: false,
  });
  if (!task) throw new Error("Missing task");
  const snapshotCommit = getHeadCommitSha(source);
  if (!snapshotCommit) throw new Error("Missing snapshot");
  prepareTaskExecutionWorkspace({
    projectId: project.id,
    taskId: task.id,
    projectRoot: source,
    worktreePath: join(directory, "task"),
    snapshotCommit,
  });
  writeFileSync(idsPath, JSON.stringify({ taskId: task.id }));
  process.stdout.write(`${JSON.stringify({ taskId: task.id })}\n`);
} else {
  const { taskId } = JSON.parse(readFileSync(idsPath, "utf8")) as { taskId: string };
  if (mode === "prepare") {
    writeFileSync(join(directory, "task", "task.txt"), "recover this task change\n");
    prepareTaskWorkspaceCheckpoint(taskId, "fix: recover checkpoint");
  } else if (mode === "publish-without-ack") {
    const row = getTaskExecutionWorkspace(taskId);
    if (!row?.intentJson) throw new Error("Missing durable intent");
    const input = {
      projectId: row.projectId,
      taskId,
      projectRoot: row.projectRoot,
      worktreePath: row.worktreePath,
      snapshotCommit: row.snapshotCommit,
    };
    const result = publishTaskCommit(restoreTaskCommitIntent(row.intentJson, input));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(23); // Simulated process death before the SQLite completion write.
  } else if (mode === "recover") {
    process.stdout.write(`${JSON.stringify(publishTaskWorkspaceCheckpoint(taskId))}\n`);
  } else if (mode === "root") {
    process.stdout.write(
      `${JSON.stringify(assertTaskExecutionAllowed(taskId, join(directory, "source")))}\n`,
    );
  } else if (mode === "reserve-continuation") {
    writeFileSync(join(directory, "source", ".git", "info", "exclude"), ".ai-factory/\n");
    mkdirSync(join(directory, "task", ".ai-factory"));
    writeFileSync(
      join(directory, "task", ".ai-factory", "RULES.md"),
      "frozen context before restart\n",
    );
    const pack = captureTaskCodeSnapshot({
      taskId,
      notes: continuationNotesSchema.parse({ goal: "Recover", nextStep: "Continue" }),
      portablePaths: [".ai-factory/RULES.md"],
    });
    const continuation = beginTaskWorkspaceContinuation({
      id: "recover-next",
      taskId,
      snapshotId: pack.id,
      worktreePath: join(directory, "next"),
    });
    writeFileSync(join(directory, "continuation.json"), JSON.stringify(continuation));
    process.stdout.write(`${JSON.stringify(continuation)}\n`);
  } else if (mode === "materialize-continuation") {
    const continuation = JSON.parse(readFileSync(join(directory, "continuation.json"), "utf8")) as {
      snapshotId: string;
      worktreePath: string;
    };
    const row = getTaskExecutionWorkspace(taskId)!;
    const pack = loadCodeSnapshotPackage(continuation.snapshotId, row.projectId);
    const checkout = {
      projectRoot: row.projectRoot,
      projectId: row.projectId,
      taskId,
      worktreePath: continuation.worktreePath,
      snapshotCommit: pack.descriptor.commitSha,
    };
    prepareTaskCheckout(checkout);
    installContextSnapshot({ checkout, package: pack });
    process.stdout.write('"materialized without activation"\n');
    // Exit after the filesystem phase; the next process must use the durable
    // reservation and frozen blobs, without capturing the source again.
  } else if (mode === "activate-continuation") {
    process.stdout.write(`${JSON.stringify(activateTaskWorkspaceContinuation("recover-next"))}\n`);
  } else if (mode !== "report") throw new Error("Unknown recovery fixture mode");
  if (mode === "prepare" || mode === "report") {
    const row = getTaskExecutionWorkspace(taskId);
    process.stdout.write(
      `${JSON.stringify({ state: row?.state, result: row?.resultJson ? JSON.parse(row.resultJson) : null })}\n`,
    );
  }
}
