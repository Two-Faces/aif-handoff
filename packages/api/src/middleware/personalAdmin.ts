import type { MiddlewareHandler } from "hono";
import { getEnv } from "@aif/shared";
import { getParticipantAuth, type ParticipantApiEnv } from "./participantAuth.js";

export const personalAdmin: MiddlewareHandler<ParticipantApiEnv> = async (c, next) => {
  if (getEnv().PARTICIPANTS_MODE_ENABLED) {
    const participant = getParticipantAuth(c)?.session?.participant;
    if (!participant?.active || participant.role !== "admin")
      return c.json({ code: "forbidden", error: "Local administrator required" }, 403);
  }
  await next();
};
