import {
  confirmManualTaskHandoffStop,
  confirmNativeTaskHandoffStop,
  checkpointTaskDeviceHandoff,
  releaseTaskDeviceHandoff,
  getTaskDeviceHandoff,
  getTaskExecutionWorkspace,
  acceptTaskDeviceHandoff,
} from "../../index.js";
import { publishTaskCommit, restoreTaskCommitIntent } from "@aif/shared";
import { getDb, type createTestDb } from "@aif/shared/server";

const [mode, id, participantId, revision] = process.argv.slice(2);
if (mode === "confirm-native")
  confirmNativeTaskHandoffStop({ id, expectedRevision: Number(revision) });
else if (mode === "confirm")
  confirmManualTaskHandoffStop({ id, participantId, expectedRevision: Number(revision) });
else if (mode === "publish-without-ack") {
  const transfer = getTaskDeviceHandoff(id),
    workspace = getTaskExecutionWorkspace(transfer.taskId);
  if (!workspace?.intentJson) throw new Error("No prepared intent");
  publishTaskCommit(
    restoreTaskCommitIntent(workspace.intentJson, {
      taskId: workspace.taskId,
      projectId: workspace.projectId,
      projectRoot: workspace.projectRoot,
      worktreePath: workspace.worktreePath,
      snapshotCommit: workspace.snapshotCommit,
    }),
  );
} else if (mode === "checkpoint") checkpointTaskDeviceHandoff(id);
else if (mode === "release") releaseTaskDeviceHandoff(id);
else if (mode === "accept-crash") {
  const sqlite = (getDb() as ReturnType<typeof createTestDb>).$client;
  sqlite.function("handoff_crash", () => process.exit(86));
  sqlite.exec(
    "CREATE TEMP TRIGGER crash_handoff_accept AFTER UPDATE OF phase ON task_device_handoffs WHEN NEW.phase='accepted' BEGIN SELECT handoff_crash(); END",
  );
  acceptTaskDeviceHandoff(id, participantId);
} else if (mode === "retry-release") {
  process.stdout.write(JSON.stringify(releaseTaskDeviceHandoff(id)));
  process.exit(0);
} else throw new Error("Unknown fixture operation");
// Exit without an application-level ACK, retaining only durable DB/Git state.
process.exit(86);
