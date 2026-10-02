import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  canonicalJson,
  DeviceHandoffError,
  taskDeviceHandoffRequestSchema,
  taskDeviceHandoffOfferSchema,
  taskDeviceHandoffReceiptSchema,
  taskDeviceHandoffs,
  taskDeviceGrantHeads,
  taskDeviceRuns,
  taskExecutionWorkspaces,
  tasks,
  participants,
  projects,
  beginTaskChangeScope,
  serializeTaskChangeScope,
  taskCheckoutFilePath,
  verifyReceivedSnapshot,
  preparedTaskCommitSha,
  restoreTaskCommitIntent,
  captureCodeSnapshotPackage,
  adoptTransferredTaskCheckpoint,
  preparedTaskCheckpointRefTarget,
  type TaskDeviceHandoffOffer,
  type TaskDeviceHandoffReceipt,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import { requirePeerProject } from "./peers.js";
import {
  getTaskDeviceGrant,
  issueTaskDeviceSuccessor,
  receiveTaskDeviceSuccessor,
  currentTaskDeviceRunId,
} from "./deviceExecution.js";
import {
  getTaskExecutionWorkspace,
  prepareTaskWorkspaceCheckpoint,
  publishTaskWorkspaceCheckpoint,
} from "./taskWorkspaces.js";
import {
  storeCodeSnapshotPackage,
  loadCodeSnapshotPackage,
  verifyLocalCodeSnapshot,
  recordLocalCodeSnapshot,
} from "./codeSnapshots.js";
import { getSnapshotTransfer } from "./snapshotTransfers.js";
import { readSyncVersions } from "./syncJournal.js";
import { handoffInputDigest, withHandoffCheckpoint } from "./deviceHandoffScope.js";

type Transfer = typeof taskDeviceHandoffs.$inferSelect;
const activePhases = ["requested", "quiescing", "checkpointed"] as const;
function fail(code: DeviceHandoffError["code"]): never {
  throw new DeviceHandoffError(code);
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function assertHostAction(): void {
  if (currentTaskDeviceRunId()) fail("handoff_manual_confirmation_required");
}
function parse(value: string | null): unknown {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return fail("handoff_invalid");
  }
}
export function getTaskDeviceHandoff(id: string): Transfer {
  return (
    getDb().select().from(taskDeviceHandoffs).where(eq(taskDeviceHandoffs.id, id)).get() ??
    fail("handoff_missing")
  );
}
export function listTaskDeviceHandoffs(projectId: string): Transfer[] {
  return getDb()
    .select()
    .from(taskDeviceHandoffs)
    .where(eq(taskDeviceHandoffs.projectId, projectId))
    .all();
}
function taskFor(row: Transfer) {
  const task = getDb()
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, row.taskId), eq(tasks.projectId, row.projectId)))
    .get();
  return task ?? fail("handoff_input_changed");
}
function unconflicted(projectId: string, taskId: string): void {
  const versions = readSyncVersions(projectId, "task", taskId);
  if (
    versions.__deleted ||
    ["__created", "plan", "workflow", "title", "description"].some(
      (key) => (versions[key]?.length ?? 0) > 1,
    )
  )
    fail("handoff_input_changed");
}
function requireSource(row: Transfer, checkInputs = true, checkPeer = true) {
  const head = getTaskDeviceGrant(row.taskId);
  if (
    row.direction !== "outgoing" ||
    row.sourceDeviceId !== getLocalDevice().deviceId ||
    !head ||
    head.projectId !== row.projectId ||
    head.ownerDeviceId !== row.sourceDeviceId ||
    head.grantId !== row.expectedGrantId ||
    !["owned", "accepted"].includes(head.state)
  )
    fail("handoff_not_owner");
  if (checkPeer) requirePeerProject(row.targetDeviceId, row.projectId);
  const task = taskFor(row);
  if (checkInputs) {
    unconflicted(row.projectId, row.taskId);
    if (handoffInputDigest(task) !== row.inputDigest) fail("handoff_input_changed");
  }
  return { head, task };
}
function revise(row: Transfer, patch: Partial<Transfer>): Transfer {
  const changed = getDb()
    .update(taskDeviceHandoffs)
    .set({ ...patch, revision: row.revision + 1, updatedAt: new Date().toISOString() })
    .where(and(eq(taskDeviceHandoffs.id, row.id), eq(taskDeviceHandoffs.revision, row.revision)))
    .run();
  if (changed.changes !== 1) fail("handoff_conflict");
  return getTaskDeviceHandoff(row.id);
}
/** Explicit host action, never a board-sync mutation or a peer-supplied command. */
export function requestTaskDeviceHandoff(value: unknown): Transfer {
  assertHostAction();
  const parsed = taskDeviceHandoffRequestSchema.safeParse(value);
  if (!parsed.success) return fail("handoff_invalid");
  const request = parsed.data;
  return getDb().transaction(() => {
    const existing = getDb()
      .select()
      .from(taskDeviceHandoffs)
      .where(eq(taskDeviceHandoffs.id, request.id))
      .get();
    if (existing) {
      if (existing.direction !== "outgoing" || existing.requestJson !== canonicalJson(request))
        fail("handoff_conflict");
      return existing;
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, request.taskId)).get();
    const head = getTaskDeviceGrant(request.taskId);
    const sourceDeviceId = getLocalDevice().deviceId;
    if (
      !task ||
      !head ||
      head.projectId !== task.projectId ||
      head.grantId !== request.expectedGrantId ||
      !["owned", "accepted"].includes(head.state) ||
      head.ownerDeviceId !== sourceDeviceId ||
      request.targetDeviceId === sourceDeviceId
    )
      fail("handoff_not_owner");
    requirePeerProject(request.targetDeviceId, task.projectId);
    unconflicted(task.projectId, task.id);
    const workspace = getTaskExecutionWorkspace(task.id);
    if (
      !workspace ||
      workspace.worktreePath !== task.worktreePath ||
      task.branchName ||
      workspace.state === "preparing"
    )
      fail("handoff_snapshot_pending");
    if (
      getDb()
        .select({ id: taskDeviceHandoffs.id })
        .from(taskDeviceHandoffs)
        .where(
          and(
            eq(taskDeviceHandoffs.taskId, task.id),
            eq(taskDeviceHandoffs.direction, "outgoing"),
            inArray(taskDeviceHandoffs.phase, [...activePhases]),
          ),
        )
        .get()
    )
      fail("handoff_conflict");
    const now = new Date().toISOString();
    getDb()
      .insert(taskDeviceHandoffs)
      .values({
        id: request.id,
        direction: "outgoing",
        taskId: task.id,
        projectId: task.projectId,
        sourceDeviceId,
        targetDeviceId: request.targetDeviceId,
        expectedGrantId: head.grantId,
        phase: "requested",
        inputDigest: handoffInputDigest(task),
        requestJson: canonicalJson(request),
        previousWorkspaceJson: canonicalJson(workspace),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return getTaskDeviceHandoff(request.id);
  });
}
/** This transition requests quiescence. It is NOT a stop acknowledgement. */
export function quiesceTaskDeviceHandoff(id: string): Transfer {
  assertHostAction();
  return getDb().transaction(() => {
    const row = getTaskDeviceHandoff(id);
    requireSource(row);
    if (row.phase === "quiescing") return row;
    if (row.phase !== "requested") fail("handoff_wrong_phase");
    return revise(row, { phase: "quiescing" });
  });
}
function requireManualStop(row: Transfer, participantId: string, checkPeer = true): void {
  const { head, task } = requireSource(row, false, checkPeer);
  const actor = getDb().select().from(participants).where(eq(participants.id, participantId)).get();
  if (!actor?.active || actor.role !== "admin" || task.executionOwner !== "human")
    fail("handoff_manual_confirmation_required");
  // Conservatively reject even completed pre-supervision runs: a resolved
  // adapter promise does not establish that it left no background children.
  const run = getDb()
    .select({ id: taskDeviceRuns.id })
    .from(taskDeviceRuns)
    .where(
      and(eq(taskDeviceRuns.taskId, row.taskId), eq(taskDeviceRuns.grantId, row.expectedGrantId)),
    )
    .get();
  if (head.activeRunId || run || task.lockedBy || task.sessionId) fail("handoff_stop_unproven");
}
/** Host-only manual-session flow. Requires a local active admin and a human
 * task with no managed run history; it cannot force-stop an autonomous task. */
export function confirmManualTaskHandoffStop(input: {
  id: string;
  expectedRevision: number;
  participantId: string;
}): Transfer {
  assertHostAction();
  return getDb().transaction(() => {
    let row = getTaskDeviceHandoff(input.id);
    requireSource(row);
    requireManualStop(row, input.participantId);
    if (row.phase !== "quiescing") fail("handoff_wrong_phase");
    if (row.stopJson) {
      const raw = parse(row.stopJson);
      const stop = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      if (
        !stop ||
        stop.participantId !== input.participantId ||
        (row.revision !== input.expectedRevision &&
          stop.confirmationRevision !== input.expectedRevision)
      )
        fail("handoff_conflict");
      return row;
    }
    if (row.revision !== input.expectedRevision) fail("handoff_conflict");
    row = revise(row, {
      stopJson: canonicalJson({
        kind: "manual",
        participantId: input.participantId,
        confirmedAt: new Date().toISOString(),
      }),
    });
    // Freeze the Git intent in the same transaction as the attestation. A crash
    // before commit cannot leave an attestation that later adopts new edits.
    const workspace = withHandoffCheckpoint(row.id, () =>
      prepareTaskWorkspaceCheckpoint(row.taskId, "handoff: checkpoint task work"),
    );
    if (!workspace.intentJson) fail("handoff_snapshot_pending");
    const request = taskDeviceHandoffRequestSchema.safeParse(parse(row.requestJson));
    if (!request.success) return fail("handoff_invalid");
    const checkout = {
      projectId: row.projectId,
      taskId: row.taskId,
      projectRoot: workspace.projectRoot,
      worktreePath: workspace.worktreePath,
      snapshotCommit: workspace.snapshotCommit,
    };
    const inherited = workspace.sourceSnapshotId
      ? loadCodeSnapshotPackage(workspace.sourceSnapshotId, row.projectId)
          .context.files.filter((file) => file.source === "portable")
          .map((file) => file.path)
      : [];
    // Freeze portable bytes before acknowledging the manual stop. No ref is
    // published until this transaction has durably saved the prepared intent.
    const pack = captureCodeSnapshotPackage({
      checkout,
      commitSha: preparedTaskCommitSha(restoreTaskCommitIntent(workspace.intentJson, checkout)),
      sourceDeviceId: row.sourceDeviceId,
      parentSnapshotId: workspace.sourceSnapshotId,
      planText: taskFor(row).plan,
      notes: request.data.notes,
      portablePaths: request.data.portablePaths ?? inherited,
    });
    storeCodeSnapshotPackage(pack);
    return revise(row, {
      snapshotId: pack.id,
      stopJson: canonicalJson({
        kind: "manual",
        participantId: input.participantId,
        confirmationRevision: input.expectedRevision,
        snapshotId: pack.id,
        intentDigest: digest(workspace.intentJson),
        confirmedAt: new Date().toISOString(),
      }),
    });
  });
}
function verifyFrozenIntent(row: Transfer): void {
  const raw = parse(row.stopJson);
  const stop = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const workspace = getTaskExecutionWorkspace(row.taskId);
  if (
    !stop ||
    stop.kind !== "manual" ||
    typeof stop.participantId !== "string" ||
    !workspace?.intentJson ||
    stop.snapshotId !== row.snapshotId ||
    !row.snapshotId ||
    stop.intentDigest !== digest(workspace.intentJson)
  )
    fail("handoff_stop_unproven");
  requireManualStop(row, stop.participantId);
  withHandoffCheckpoint(row.id, () => publishTaskWorkspaceCheckpoint(row.taskId));
}
export function checkpointTaskDeviceHandoff(id: string): Transfer {
  assertHostAction();
  const row = getTaskDeviceHandoff(id);
  requireSource(row);
  if (row.phase !== "quiescing" && row.phase !== "checkpointed") fail("handoff_wrong_phase");
  verifyFrozenIntent(row);
  if (!row.snapshotId) fail("handoff_snapshot_pending");
  recordLocalCodeSnapshot(
    row.projectId,
    row.snapshotId,
    getTaskExecutionWorkspace(row.taskId)!.projectRoot,
  );
  if (row.phase === "checkpointed") return row;
  const pack = loadCodeSnapshotPackage(row.snapshotId, row.projectId);
  return getDb().transaction(() => {
    const current = getTaskDeviceHandoff(id);
    requireSource(current);
    verifyFrozenIntent(current);
    if (current.phase === "checkpointed" && current.snapshotId === pack.id) return current;
    if (current.phase !== "quiescing" || current.revision !== row.revision)
      fail("handoff_conflict");
    return revise(current, { phase: "checkpointed", snapshotId: pack.id });
  });
}
function offer(row: Transfer): TaskDeviceHandoffOffer {
  const parsed = taskDeviceHandoffOfferSchema.safeParse({
    version: 1,
    id: row.id,
    grant: parse(row.successorJson),
  });
  if (
    !parsed.success ||
    parsed.data.grant.taskId !== row.taskId ||
    parsed.data.grant.projectId !== row.projectId ||
    parsed.data.grant.predecessorId !== row.expectedGrantId ||
    parsed.data.grant.ownerDeviceId !== row.targetDeviceId ||
    parsed.data.grant.issuerDeviceId !== row.sourceDeviceId ||
    parsed.data.grant.snapshotId !== row.snapshotId ||
    row.successorGrantId !== digest(canonicalJson(parsed.data.grant))
  )
    return fail("handoff_invalid");
  return parsed.data;
}
export function getReleasedTaskHandoffOffer(id: string): TaskDeviceHandoffOffer {
  const row = getTaskDeviceHandoff(id);
  if (
    row.direction !== "outgoing" ||
    row.sourceDeviceId !== getLocalDevice().deviceId ||
    !["released", "received", "accepted"].includes(row.phase)
  )
    fail("handoff_wrong_phase");
  requirePeerProject(row.targetDeviceId, row.projectId);
  return offer(row);
}
export function releaseTaskDeviceHandoff(id: string): TaskDeviceHandoffOffer {
  assertHostAction();
  return getDb().transaction(() => {
    const row = getTaskDeviceHandoff(id);
    if (["released", "received", "accepted"].includes(row.phase))
      return getReleasedTaskHandoffOffer(id);
    const { head } = requireSource(row);
    if (row.phase !== "checkpointed" || !row.snapshotId) fail("handoff_wrong_phase");
    verifyFrozenIntent(row);
    const workspace = getTaskExecutionWorkspace(row.taskId)!;
    const pack = verifyLocalCodeSnapshot(row.snapshotId, row.projectId, workspace.projectRoot);
    if (pack.descriptor.taskId !== row.taskId || pack.context.plan.text !== taskFor(row).plan)
      fail("handoff_input_changed");
    getDb()
      .update(taskDeviceGrantHeads)
      .set({ state: "released", releasedTransferId: row.id, releasedSnapshotId: pack.id })
      .where(
        and(
          eq(taskDeviceGrantHeads.taskId, row.taskId),
          eq(taskDeviceGrantHeads.grantId, head.grantId),
        ),
      )
      .run();
    const successor = issueTaskDeviceSuccessor({
      taskId: row.taskId,
      expectedGrantId: head.grantId,
      targetDeviceId: row.targetDeviceId,
      transferId: row.id,
      snapshotId: pack.id,
    });
    const released = revise(row, {
      phase: "released",
      successorJson: canonicalJson(successor),
      successorGrantId: digest(canonicalJson(successor)),
    });
    return offer(released);
  });
}
export function cancelTaskDeviceHandoff(input: {
  id: string;
  expectedRevision: number;
  participantId: string;
}): Transfer {
  assertHostAction();
  return getDb().transaction(() => {
    const row = getTaskDeviceHandoff(input.id);
    if (row.direction !== "outgoing") fail("handoff_wrong_phase");
    if (["released", "received", "accepted"].includes(row.phase)) fail("handoff_irreversible");
    requireManualStop(row, input.participantId, false);
    if (row.phase === "cancelled") return row;
    if (row.revision !== input.expectedRevision) fail("handoff_conflict");
    return revise(row, { phase: "cancelled" });
  });
}
/** A receipt can safely be reconstructed after a crash between grant staging
 * and journal insertion. A pending grant never permits execution. */
export function receiveTaskDeviceHandoff(peerId: string, value: unknown): TaskDeviceHandoffReceipt {
  const parsed = taskDeviceHandoffOfferSchema.safeParse(value);
  if (!parsed.success) return fail("handoff_invalid");
  const incoming = parsed.data,
    grant = incoming.grant;
  requirePeerProject(peerId, grant.projectId);
  if (peerId !== grant.issuerDeviceId || grant.ownerDeviceId !== getLocalDevice().deviceId)
    fail("handoff_not_owner");
  const previous = getDb()
    .select()
    .from(taskDeviceHandoffs)
    .where(eq(taskDeviceHandoffs.id, incoming.id))
    .get();
  if (
    previous &&
    (previous.direction !== "incoming" ||
      canonicalJson(offer(previous)) !== canonicalJson(incoming))
  )
    fail("handoff_conflict");
  // Keep fork quarantine durable: receiveTaskDeviceSuccessor intentionally
  // commits it before throwing, so do not wrap this call in an outer transaction.
  receiveTaskDeviceSuccessor(peerId, grant);
  return getDb().transaction(() => {
    const existing = getDb()
      .select()
      .from(taskDeviceHandoffs)
      .where(eq(taskDeviceHandoffs.id, incoming.id))
      .get();
    if (!existing) {
      const now = new Date().toISOString();
      getDb()
        .insert(taskDeviceHandoffs)
        .values({
          id: incoming.id,
          direction: "incoming",
          projectId: grant.projectId,
          taskId: grant.taskId,
          sourceDeviceId: peerId,
          targetDeviceId: grant.ownerDeviceId,
          expectedGrantId: grant.predecessorId!,
          phase: "received",
          snapshotId: grant.snapshotId,
          successorJson: canonicalJson(grant),
          successorGrantId: digest(canonicalJson(grant)),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    return readTaskHandoffReceipt(peerId, grant.projectId, incoming.id);
  });
}
export function readTaskHandoffReceipt(
  peerId: string,
  projectId: string,
  id: string,
): TaskDeviceHandoffReceipt {
  requirePeerProject(peerId, projectId);
  const row = getTaskDeviceHandoff(id);
  if (
    row.direction !== "incoming" ||
    row.projectId !== projectId ||
    row.sourceDeviceId !== peerId ||
    row.targetDeviceId !== getLocalDevice().deviceId ||
    !["received", "accepted"].includes(row.phase)
  )
    fail("handoff_not_owner");
  const granted = offer(row).grant;
  return {
    id,
    grantId: digest(canonicalJson(granted)),
    state: row.phase === "accepted" ? "accepted" : "received",
  };
}
export function recordTaskHandoffReceipt(peerId: string, value: unknown): Transfer {
  const parsed = taskDeviceHandoffReceiptSchema.safeParse(value);
  if (!parsed.success) return fail("handoff_invalid");
  return getDb().transaction(() => {
    const receipt = parsed.data,
      row = getTaskDeviceHandoff(receipt.id);
    const released = getReleasedTaskHandoffOffer(row.id);
    if (peerId !== row.targetDeviceId || receipt.grantId !== digest(canonicalJson(released.grant)))
      fail("handoff_conflict");
    if (row.phase === "accepted" || row.phase === receipt.state) return row;
    return revise(row, { phase: receipt.state });
  });
}
/** Explicit local acceptance, after P12 verified import. It binds a fresh scope
 * to the exact local snapshot and clears native session reuse; never starts AI. */
export function acceptTaskDeviceHandoff(id: string, localTransferId: string): Transfer {
  assertHostAction();
  const row = getTaskDeviceHandoff(id);
  if (row.direction !== "incoming" || row.targetDeviceId !== getLocalDevice().deviceId)
    fail("handoff_not_owner");
  requirePeerProject(row.sourceDeviceId, row.projectId);
  if (row.phase === "accepted") {
    if (row.localTransferId !== localTransferId) fail("handoff_conflict");
    return row;
  }
  if (row.phase !== "received") fail("handoff_wrong_phase");
  const granted = offer(row).grant;
  const imported = getSnapshotTransfer(localTransferId);
  if (
    imported.peerId !== row.sourceDeviceId ||
    imported.projectId !== row.projectId ||
    imported.snapshotId !== row.snapshotId ||
    imported.manifest.descriptor.taskId !== row.taskId ||
    !imported.completed ||
    !imported.codeReady ||
    !imported.contextReady ||
    imported.status !== "ready"
  )
    fail("handoff_snapshot_pending");
  const pack = loadCodeSnapshotPackage(imported.snapshotId, row.projectId);
  if (pack.descriptor.sourceDeviceId !== row.sourceDeviceId) fail("handoff_invalid");
  const checkout = {
    projectId: row.projectId,
    taskId: row.taskId,
    projectRoot: imported.projectRoot,
    worktreePath: imported.worktreePath,
    snapshotCommit: pack.descriptor.commitSha,
  };
  const preflight = (current: Transfer) => {
    const head = getTaskDeviceGrant(row.taskId),
      task = taskFor(row);
    requirePeerProject(row.sourceDeviceId, row.projectId);
    unconflicted(row.projectId, row.taskId);
    if (current.phase !== "received") fail("handoff_conflict");
    if (
      !head ||
      head.projectId !== row.projectId ||
      head.executionEpoch !== granted.executionEpoch ||
      head.state !== "pending" ||
      head.grantId !== digest(canonicalJson(granted)) ||
      head.activeRunId ||
      head.ownerDeviceId !== getLocalDevice().deviceId
    )
      fail("handoff_not_owner");
    if (task.lockedBy || task.plan !== pack.context.plan.text) fail("handoff_input_changed");
    const prior = getTaskExecutionWorkspace(row.taskId);
    if (prior && prior.state !== "checkpointed") fail("handoff_conflict");
    if (
      (!prior && (task.worktreePath || task.branchName)) ||
      (prior && (task.worktreePath !== prior.worktreePath || task.branchName !== null))
    )
      fail("handoff_conflict");
    const project = getDb().select().from(projects).where(eq(projects.id, row.projectId)).get();
    if (!project || relative(resolve(project.rootPath), resolve(imported.projectRoot)) !== "")
      fail("handoff_snapshot_pending");
    const planPath =
      prior && task.planPath
        ? relative(prior.worktreePath, taskCheckoutFilePath(prior.worktreePath, task.planPath))
            .split("\\")
            .join("/")
        : task.planPath;
    if (planPath) taskCheckoutFilePath(checkout.worktreePath, planPath);
    return { task, prior, planPath };
  };
  // Reserve the selected local checkout BEFORE changing the internal Git ref.
  // A crash/retry cannot silently choose a different checkout or old baseline.
  const reserved = getDb().transaction(() => {
    const current = getTaskDeviceHandoff(id),
      { prior } = preflight(current);
    const previousWorkspaceJson = prior ? canonicalJson(prior) : null;
    if (current.localTransferId) {
      if (
        current.localTransferId !== localTransferId ||
        current.previousWorkspaceJson !== previousWorkspaceJson
      )
        fail("handoff_conflict");
      return current;
    }
    return revise(current, { localTransferId, previousWorkspaceJson });
  });
  verifyLocalCodeSnapshot(imported.snapshotId, row.projectId, imported.projectRoot);
  verifyReceivedSnapshot(checkout, pack);
  const prior = getTaskExecutionWorkspace(row.taskId);
  if ((prior ? canonicalJson(prior) : null) !== reserved.previousWorkspaceJson)
    fail("handoff_conflict");
  const previousIntent = prior?.intentJson
    ? restoreTaskCommitIntent(prior.intentJson, {
        projectId: prior.projectId,
        taskId: prior.taskId,
        projectRoot: prior.projectRoot,
        worktreePath: prior.worktreePath,
        snapshotCommit: prior.snapshotCommit,
      })
    : null;
  if (prior && !previousIntent) fail("handoff_conflict");
  adoptTransferredTaskCheckpoint(
    checkout,
    previousIntent ? preparedTaskCheckpointRefTarget(previousIntent) : null,
    previousIntent ? preparedTaskCommitSha(previousIntent) : null,
  );
  const scope = beginTaskChangeScope(checkout, {
    requireClean: true,
    contextPaths: pack.context.files
      .filter((file) => file.source === "portable")
      .map((file) => file.path),
  });
  return getDb().transaction(() => {
    const current = getTaskDeviceHandoff(id),
      { prior, planPath } = preflight(current);
    getSnapshotTransfer(localTransferId);
    if (
      current.revision !== reserved.revision ||
      current.localTransferId !== localTransferId ||
      (prior ? canonicalJson(prior) : null) !== reserved.previousWorkspaceJson
    )
      fail("handoff_conflict");
    const values = {
      ...checkout,
      state: "active" as const,
      sourceSnapshotId: pack.id,
      scopeJson: serializeTaskChangeScope(scope),
      revision: (prior?.revision ?? -1) + 1,
      intentJson: null,
      resultJson: null,
    };
    if (prior)
      getDb()
        .update(taskExecutionWorkspaces)
        .set(values)
        .where(eq(taskExecutionWorkspaces.taskId, row.taskId))
        .run();
    else getDb().insert(taskExecutionWorkspaces).values(values).run();
    getDb()
      .update(tasks)
      .set({
        worktreePath: checkout.worktreePath,
        branchName: null,
        planPath,
        sessionId: null,
        activeRuntimeStatus: null,
        activeRuntimeSelectionJson: null,
        autoQueueCommitStatus: null,
        autoQueueCommitBaseSha: checkout.snapshotCommit,
        commitSha: null,
        autoQueueCommitError: null,
        autoQueueCommitCompletedAt: null,
      })
      .where(eq(tasks.id, row.taskId))
      .run();
    getDb()
      .update(taskDeviceGrantHeads)
      .set({ state: "accepted" })
      .where(eq(taskDeviceGrantHeads.taskId, row.taskId))
      .run();
    return revise(current, {
      phase: "accepted",
      localTransferId,
      previousWorkspaceJson: prior ? canonicalJson(prior) : null,
    });
  });
}
