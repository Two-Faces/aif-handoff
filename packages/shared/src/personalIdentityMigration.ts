import type Database from "better-sqlite3";

/** Backfill only proven local identities; remote identity mapping is explicit. */
export function backfillPersonalIdentity(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO handoff_local_device (slot, device_id, incarnation, name) VALUES (1, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), crypto.randomUUID(), "Local device");
  const device = sqlite
    .prepare("SELECT device_id FROM handoff_local_device WHERE slot = 1")
    .get() as { device_id: string } | undefined;
  if (!device) throw new Error("Local device identity was not created");
  const projects = sqlite.prepare("SELECT id, root_path FROM projects").all() as Array<{
    id: string;
    root_path: string;
  }>;
  for (const project of projects) {
    if (project.root_path) {
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO handoff_project_checkouts (id, project_id, device_id, local_root, execution_environment) VALUES (?, ?, ?, ?, 'unknown')`,
        )
        .run(crypto.randomUUID(), project.id, device.device_id, project.root_path);
    }
    const people = sqlite
      .prepare(
        `SELECT DISTINCT p.id, p.display_name FROM participants p WHERE p.id IN (
      SELECT a.participant_id FROM task_assignments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?
      UNION SELECT c.participant_id FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?
    )`,
      )
      .all(project.id, project.id) as Array<{ id: string; display_name: string }>;
    for (const person of people) {
      const logicalId = crypto.randomUUID();
      sqlite
        .prepare("INSERT INTO handoff_participants (project_id, id, display_name) VALUES (?, ?, ?)")
        .run(project.id, logicalId, person.display_name);
      sqlite
        .prepare(
          "INSERT INTO handoff_participant_bindings (project_id, logical_participant_id, participant_id) VALUES (?, ?, ?)",
        )
        .run(project.id, logicalId, person.id);
      sqlite
        .prepare(
          `UPDATE task_comments SET logical_author_id = ?, author_display_name_snapshot = ? WHERE participant_id = ? AND task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
        )
        .run(logicalId, person.display_name, person.id, project.id);
      sqlite
        .prepare(
          `INSERT INTO handoff_task_assignments (task_id, logical_participant_id, display_name_snapshot) SELECT a.task_id, ?, ? FROM task_assignments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ? AND a.participant_id = ?`,
        )
        .run(logicalId, person.display_name, project.id, person.id);
    }
  }
}
