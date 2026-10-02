import { eq } from "drizzle-orm";
import {
  getEnv,
  PersonalExecutionDisabledError,
  PERSONAL_EXECUTION_BLOCK,
  projects,
  tasks,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

/** Persisted policy survives disabling the onboarding environment switch. */
export function isPersonalProject(projectId: string): boolean {
  if (getEnv().AIF_PERSONAL_MODE) return true;
  const project = getDb()
    .select({ personalMode: projects.personalMode })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  return project?.personalMode === true;
}

export function isPersonalTask(taskId: string): boolean {
  if (getEnv().AIF_PERSONAL_MODE) return true;
  const task = getDb()
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  return task ? isPersonalProject(task.projectId) : false;
}

export function assertProjectExecutionAllowed(projectId: string, taskId?: string | null): void {
  if (getPersonalExecutionBlock(projectId, taskId)) {
    throw new PersonalExecutionDisabledError();
  }
}

export function getPersonalExecutionBlock(projectId: string, taskId?: string | null) {
  return isPersonalProject(projectId) || (taskId && isPersonalTask(taskId))
    ? PERSONAL_EXECUTION_BLOCK
    : null;
}

export function assertTaskExecutionAllowed(taskId: string): void {
  if (isPersonalTask(taskId)) throw new PersonalExecutionDisabledError();
}

export function isProjectPublicationAllowed(projectId: string): boolean {
  if (isPersonalProject(projectId)) return false;
  const project = getDb()
    .select({ publicationPolicy: projects.publicationPolicy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  return project?.publicationPolicy !== "local_only";
}
