import { and, eq } from "drizzle-orm";
import { projectCheckouts, projects } from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { getLocalDevice } from "./devices.js";
import { createProject, type ProjectRow } from "./index.js";

export type ExecutionEnvironment =
  | "native_windows"
  | "native_macos"
  | "native_linux"
  | "wsl"
  | "container"
  | "unknown";

export class ProjectBindingError extends Error {
  constructor(
    readonly code:
      | "project_not_found"
      | "checkout_already_bound"
      | "personal_project_required"
      | "registration_failed",
  ) {
    super(code);
    this.name = "ProjectBindingError";
  }
}

export function listProjectCheckouts(projectId: string) {
  return getDb()
    .select()
    .from(projectCheckouts)
    .where(eq(projectCheckouts.projectId, projectId))
    .all();
}

export function bindProjectCheckout(input: {
  projectId: string;
  localRoot: string;
  executionEnvironment: ExecutionEnvironment;
  head: string | null;
  branch: string | null;
}) {
  return getDb().transaction((tx) => {
    if (
      !tx.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()
    ) {
      throw new ProjectBindingError("project_not_found");
    }
    const { deviceId } = getLocalDevice();
    const existing = tx
      .select()
      .from(projectCheckouts)
      .where(
        and(
          eq(projectCheckouts.deviceId, deviceId),
          eq(projectCheckouts.localRoot, input.localRoot),
          eq(projectCheckouts.executionEnvironment, input.executionEnvironment),
        ),
      )
      .get();
    if (existing && existing.projectId !== input.projectId)
      throw new ProjectBindingError("checkout_already_bound");
    const id = existing?.id ?? crypto.randomUUID();
    tx.insert(projectCheckouts)
      .values({ id, deviceId, ...input })
      .onConflictDoUpdate({
        target: projectCheckouts.id,
        set: { head: input.head, branch: input.branch },
      })
      .run();
    return { id, deviceId, ...input };
  });
}

/** The caller has inspected the checkout. No filesystem or runtime effects here. */
export function registerPersonalCheckout(
  input: Parameters<typeof createProject>[0] & {
    projectId?: string;
    executionEnvironment: ExecutionEnvironment;
    head: string | null;
    branch: string | null;
  },
): ProjectRow {
  return getDb().transaction((tx) => {
    const project = input.projectId
      ? tx.select().from(projects).where(eq(projects.id, input.projectId)).get()
      : createProject({ ...input, personalMode: true });
    if (!project)
      throw new ProjectBindingError(input.projectId ? "project_not_found" : "registration_failed");
    if (!project.personalMode) throw new ProjectBindingError("personal_project_required");
    bindProjectCheckout({
      projectId: project.id,
      localRoot: input.rootPath,
      executionEnvironment: input.executionEnvironment,
      head: input.head,
      branch: input.branch,
    });
    return project;
  });
}
