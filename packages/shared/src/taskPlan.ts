import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { projects, tasks } from "./schema.js";
import { syncPlanTextToCanonicalFile } from "./planFile.js";

interface PersistTaskPlanInput {
  db: ReturnType<typeof getDb>;
  taskId: string;
  planText: string | null;
  updatedAt?: string;
  projectRoot?: string;
  isFix?: boolean;
  planPath?: string;
}

export function persistTaskPlan(input: PersistTaskPlanInput): { updatedAt: string } {
  let projectRoot = input.projectRoot;
  let isFix = input.isFix;
  let planPath = input.planPath;

  if (!projectRoot || isFix == null) {
    const task = input.db
      .select({
        projectId: tasks.projectId,
        isFix: tasks.isFix,
        planPath: tasks.planPath,
        worktreePath: tasks.worktreePath,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .get();

    if (!task) {
      throw new Error(`Task ${input.taskId} not found`);
    }

    const project = input.db
      .select({
        rootPath: projects.rootPath,
      })
      .from(projects)
      .where(eq(projects.id, task.projectId))
      .get();

    if (!project) {
      throw new Error(`Project not found for task ${input.taskId}`);
    }

    projectRoot = projectRoot ?? task.worktreePath ?? project.rootPath;
    isFix = isFix ?? task.isFix;
    planPath = planPath ?? task.planPath;
  }

  syncPlanTextToCanonicalFile({
    projectRoot,
    isFix,
    planPath,
    planText: input.planText,
  });

  const updatedAt = input.updatedAt ?? new Date().toISOString();
  input.db
    .update(tasks)
    .set({
      plan: input.planText,
      updatedAt,
    })
    .where(eq(tasks.id, input.taskId))
    .run();

  return { updatedAt };
}
