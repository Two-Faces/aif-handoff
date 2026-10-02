import type { MiddlewareHandler } from "hono";
import { isPersonalProject, isPersonalTask } from "@aif/data";
import { PERSONAL_EXECUTION_BLOCK } from "@aif/shared";

export const personalTaskExecutionGate: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "POST" && isPersonalTask(c.req.param("id") ?? "")) {
    return c.json(PERSONAL_EXECUTION_BLOCK, 403);
  }
  await next();
};

export const personalProjectExecutionGate: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "POST" && isPersonalProject(c.req.param("id") ?? "")) {
    return c.json(PERSONAL_EXECUTION_BLOCK, 403);
  }
  await next();
};
