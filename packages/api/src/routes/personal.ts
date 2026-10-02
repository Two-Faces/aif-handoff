import { Hono } from "hono";
import type { z } from "zod";
import {
  bindLogicalParticipant,
  getLocalDevice,
  listLogicalParticipants,
  listProjectCheckouts,
  ParticipantBindingError,
  ProjectBindingError,
  registerPersonalCheckout,
} from "@aif/data";
import { ExistingCheckoutError, inspectExistingCheckout } from "@aif/shared";
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

export const personalProjectsRouter = new Hono();

personalProjectsRouter.onError((error, c) => {
  if (error instanceof ExistingCheckoutError)
    return c.json({ code: error.code, error: error.message }, 400);
  if (
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
