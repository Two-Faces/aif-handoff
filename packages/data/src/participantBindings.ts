import { and, eq } from "drizzle-orm";
import { logicalParticipants, participantBindings, participants } from "@aif/shared";
import { getDb } from "@aif/shared/server";

export class ParticipantBindingError extends Error {
  constructor(
    readonly code: "identity_not_found" | "participant_inactive" | "identity_already_bound",
  ) {
    super(code);
    this.name = "ParticipantBindingError";
  }
}

export function listLogicalParticipants(projectId: string) {
  return getDb()
    .select({
      id: logicalParticipants.id,
      projectId: logicalParticipants.projectId,
      displayName: logicalParticipants.displayName,
      localParticipantId: participantBindings.participantId,
    })
    .from(logicalParticipants)
    .leftJoin(
      participantBindings,
      and(
        eq(participantBindings.projectId, logicalParticipants.projectId),
        eq(participantBindings.logicalParticipantId, logicalParticipants.id),
      ),
    )
    .where(eq(logicalParticipants.projectId, projectId))
    .all();
}

/** Creating an attribution record never creates credentials or grants local access. */
export function recordLogicalParticipant(input: {
  projectId: string;
  id: string;
  displayName: string;
}) {
  getDb().insert(logicalParticipants).values(input).onConflictDoNothing().run();
}

export function bindLogicalParticipant(input: {
  projectId: string;
  logicalParticipantId: string;
  participantId: string;
}) {
  return getDb().transaction((tx) => {
    const identity = tx
      .select()
      .from(logicalParticipants)
      .where(
        and(
          eq(logicalParticipants.projectId, input.projectId),
          eq(logicalParticipants.id, input.logicalParticipantId),
        ),
      )
      .get();
    if (!identity) throw new ParticipantBindingError("identity_not_found");
    const person = tx
      .select()
      .from(participants)
      .where(eq(participants.id, input.participantId))
      .get();
    if (!person?.active) throw new ParticipantBindingError("participant_inactive");
    const previous = tx
      .select()
      .from(participantBindings)
      .where(
        and(
          eq(participantBindings.projectId, input.projectId),
          eq(participantBindings.logicalParticipantId, input.logicalParticipantId),
        ),
      )
      .get();
    if (previous && previous.participantId !== input.participantId)
      throw new ParticipantBindingError("identity_already_bound");
    tx.insert(participantBindings).values(input).onConflictDoNothing().run();
    return input;
  });
}

export function resolveLocalParticipant(projectId: string, logicalParticipantId: string) {
  const row = getDb()
    .select({ participantId: participants.id })
    .from(participantBindings)
    .innerJoin(participants, eq(participantBindings.participantId, participants.id))
    .where(
      and(
        eq(participantBindings.projectId, projectId),
        eq(participantBindings.logicalParticipantId, logicalParticipantId),
        eq(participants.active, true),
      ),
    )
    .get();
  return row?.participantId ?? null;
}

/** Only known local authors may receive an automatically created source identity. */
export function ensureLocalParticipantIdentity(projectId: string, participantId: string) {
  return getDb().transaction((tx) => {
    const person = tx.select().from(participants).where(eq(participants.id, participantId)).get();
    if (!person?.active) throw new ParticipantBindingError("participant_inactive");
    const binding = tx
      .select()
      .from(participantBindings)
      .where(
        and(
          eq(participantBindings.projectId, projectId),
          eq(participantBindings.participantId, participantId),
        ),
      )
      .get();
    if (binding) return binding.logicalParticipantId;
    const id = crypto.randomUUID();
    recordLogicalParticipant({ projectId, id, displayName: person.displayName });
    bindLogicalParticipant({ projectId, logicalParticipantId: id, participantId });
    return id;
  });
}
