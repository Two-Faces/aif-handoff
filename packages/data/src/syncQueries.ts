import { eq } from "drizzle-orm";
import { logicalTaskAssignments, type SyncRevisions } from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { resolveLocalParticipant } from "./participantBindings.js";
import {
  ensureProjectSyncState,
  getEntitySyncRevisions,
  isReplicatedProject,
} from "./syncMutations.js";

export interface PersonalTaskMetadata {
  personalMode?: boolean;
  syncRevisions?: SyncRevisions;
  unresolvedAssignees?: Array<{ logicalParticipantId: string; displayName: string }>;
}

export function taskSyncMetadata(projectId: string, taskId: string): PersonalTaskMetadata {
  if (!isReplicatedProject(projectId)) return {};
  ensureProjectSyncState(projectId);
  const unresolvedAssignees = getDb()
    .select()
    .from(logicalTaskAssignments)
    .where(eq(logicalTaskAssignments.taskId, taskId))
    .all()
    .filter((row) => !resolveLocalParticipant(projectId, row.logicalParticipantId))
    .map((row) => ({
      logicalParticipantId: row.logicalParticipantId,
      displayName: row.displayNameSnapshot,
    }));
  return {
    personalMode: true,
    syncRevisions: getEntitySyncRevisions(projectId, "task", taskId),
    unresolvedAssignees,
  };
}
