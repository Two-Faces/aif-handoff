import { Hono } from "hono";
import { z } from "zod";
import {
  bindLogicalParticipant,
  getLocalDevice,
  listLogicalParticipants,
  listProjectCheckouts,
  ParticipantBindingError,
  ProjectBindingError,
  registerPersonalCheckout,
  listSyncConflicts,
  resolveSyncConflict,
  ensureProjectSyncState,
  findTaskById,
} from "@aif/data";
import {
  ExistingCheckoutError,
  inspectExistingCheckout,
  SyncError,
  syncDotSchema,
} from "@aif/shared";
import { personalAdmin } from "../middleware/personalAdmin.js";
import { getParticipantAuth, type ParticipantApiEnv } from "../middleware/participantAuth.js";
import { broadcast } from "../ws.js";
import { jsonValidator } from "../middleware/zodValidator.js";
import {
  createPortableProjectManifest,
  ProjectManifestError,
} from "../services/personalRegistration.js";
import {
  personalInventoryPreviewSchema,
  personalCheckoutBindingSchema,
  personalParticipantBindingSchema,
  personalManifestSchema,
} from "../schemas.js";

export const personalProjectsRouter = new Hono<ParticipantApiEnv>();
personalProjectsRouter.use("*", async (c, next) => {
  if (c.req.method !== "GET") return personalAdmin(c, next);
  await next();
});

personalProjectsRouter.onError((error, c) => {
  if (error instanceof ExistingCheckoutError)
    return c.json({ code: error.code, error: error.message }, 400);
  if (
    error instanceof SyncError ||
    error instanceof ProjectBindingError ||
    error instanceof ParticipantBindingError ||
    error instanceof ProjectManifestError
  ) {
    return c.json({ code: error.code, error: error.message }, 409);
  }
  throw error;
});

personalProjectsRouter.post(
  "/attach-preview",
  jsonValidator(personalInventoryPreviewSchema),
  (c) => {
    const body: z.infer<typeof personalInventoryPreviewSchema> = c.req.valid("json");
    const items = body.checkouts.map((input) => {
      try {
        return { ...input, ok: true as const, ...inspectExistingCheckout(input.localRoot) };
      } catch (error) {
        if (!(error instanceof ExistingCheckoutError)) throw error;
        return { ...input, ok: false as const, code: error.code };
      }
    });
    return c.json({ checkouts: items, registrationPerformed: false });
  },
);

personalProjectsRouter.get("/:id/checkouts", (c) =>
  c.json({
    device: getLocalDevice(),
    checkouts: listProjectCheckouts(c.req.param("id")),
  }),
);

personalProjectsRouter.post("/:id/checkouts", jsonValidator(personalCheckoutBindingSchema), (c) => {
  const input = c.req.valid("json");
  const checkout = inspectExistingCheckout(input.localRoot);
  const project = registerPersonalCheckout({
    projectId: c.req.param("id"),
    name: "",
    ...checkout,
    executionEnvironment: input.executionEnvironment,
  });
  return c.json({ project, checkouts: listProjectCheckouts(project.id) }, 201);
});

personalProjectsRouter.get("/:id/identities", (c) =>
  c.json(listLogicalParticipants(c.req.param("id"))),
);

personalProjectsRouter.get("/:id/conflicts", (c) => {
  ensureProjectSyncState(c.req.param("id"));
  return c.json(listSyncConflicts(c.req.param("id")));
});
const resolutionSchema = z
  .object({
    entityType: z.enum(["project", "task", "comment", "participant"]),
    entityId: z.uuid(),
    field: z.string().min(1).max(100),
    value: z.json(),
    parents: z.array(syncDotSchema).min(1).max(100),
  })
  .strict();
personalProjectsRouter.post("/:id/conflicts/resolve", jsonValidator(resolutionSchema), (c) => {
  const body = c.req.valid("json");
  const participant = getParticipantAuth(c)?.session?.participant;
  resolveSyncConflict({
    ...body,
    projectId: c.req.param("id"),
    actor: participant
      ? { kind: "participant", id: participant.id, displayNameSnapshot: participant.displayName }
      : { kind: "anonymous", id: null, displayNameSnapshot: null },
  });
  if (body.entityType === "task") {
    const task = findTaskById(body.entityId);
    if (task)
      broadcast({ type: "task:updated", payload: { id: task.id, projectId: task.projectId } });
  }
  return c.json({ resolved: true });
});
personalProjectsRouter.post(
  "/:id/identities/bind",
  jsonValidator(personalParticipantBindingSchema),
  (c) => {
    const { logicalParticipantId, participantId } = c.req.valid("json");
    return c.json(
      bindLogicalParticipant({ projectId: c.req.param("id"), logicalParticipantId, participantId }),
    );
  },
);

personalProjectsRouter.post("/:id/manifest", jsonValidator(personalManifestSchema), (c) => {
  return c.json(
    createPortableProjectManifest(c.req.param("id"), c.req.valid("json").checkoutId),
    201,
  );
});
