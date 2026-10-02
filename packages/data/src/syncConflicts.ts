import { getDb } from "@aif/shared/server";
import { SyncError, type AuditActor, type SyncDot, type SyncEntityType } from "@aif/shared";
import { materializeSharedEntity, portableActor } from "./syncDomain.js";
import { ensureProjectSyncState, recordIdentityDependencies } from "./syncMutations.js";
import { readSyncEntity, recordLocalSyncChange, runRemoteSyncProjection } from "./syncJournal.js";

/** Explicit parent-set CAS prevents a resolution from swallowing a later offline variant. */
export function resolveSyncConflict(input: {
  projectId: string;
  entityType: SyncEntityType;
  entityId: string;
  field: string;
  value: unknown;
  parents: SyncDot[];
  actor: AuditActor;
}): void {
  getDb().transaction(() => {
    ensureProjectSyncState(input.projectId);
    if (!readSyncEntity(input.projectId, input.entityType, input.entityId))
      throw new SyncError("entity_not_ready");
    const actor = portableActor(input.projectId, input.actor);
    recordIdentityDependencies(input.projectId);
    recordLocalSyncChange({
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      intent: "resolve",
      fields: { [input.field]: input.value },
      parents: { [input.field]: input.parents },
      actorKind: input.actor.kind,
      actor,
    });
    runRemoteSyncProjection(() =>
      materializeSharedEntity(
        input,
        readSyncEntity(input.projectId, input.entityType, input.entityId),
      ),
    );
  });
}
