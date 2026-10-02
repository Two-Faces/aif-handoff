import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb } from "../db.js";

describe("personal identity migration", () => {
  it("backfills v30 roots, local assignments and authors without copying credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "aif-identity-migration-"));
    const path = join(directory, "db.sqlite");
    closeDb();
    const connections: Database.Database[] = [];
    try {
      getDb(path);
      closeDb();
      const old = new Database(path);
      connections.push(old);
      for (const table of [
        "handoff_task_assignments",
        "handoff_participant_bindings",
        "handoff_participants",
        "handoff_project_checkouts",
        "handoff_local_device",
      ]) {
        old.exec(`DROP TABLE ${table}`);
      }
      old.exec("ALTER TABLE task_comments DROP COLUMN logical_author_id");
      old.exec("ALTER TABLE task_comments DROP COLUMN author_display_name_snapshot");
      old
        .prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)")
        .run("project", "Keep", "old-local-root");
      old
        .prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)")
        .run("duplicate-root", "Also keep", "old-local-root");
      old
        .prepare(
          "INSERT INTO participants (id, username, normalized_username, display_name, password_hash) VALUES (?, ?, ?, ?, ?)",
        )
        .run("local-user", "owner", "owner", "Original owner", "password-must-stay-local");
      old
        .prepare(
          "INSERT INTO tasks (id, project_id, title, execution_owner) VALUES (?, ?, ?, 'human')",
        )
        .run("task", "project", "Keep task");
      old
        .prepare(
          "INSERT INTO task_assignments (task_id, participant_id, assigned_by_kind) VALUES (?, ?, 'participant')",
        )
        .run("task", "local-user");
      old
        .prepare(
          "INSERT INTO task_comments (id, task_id, participant_id, message) VALUES (?, ?, ?, ?)",
        )
        .run("comment", "task", "local-user", "Keep comment");
      old.pragma("user_version = 30");
      old.close();
      getDb(path);
      closeDb();
      const migrated = new Database(path, { readonly: true });
      connections.push(migrated);
      expect(migrated.pragma("user_version", { simple: true })).toBe(35);
      expect(
        migrated
          .prepare(
            "SELECT project_id, local_root, execution_environment FROM handoff_project_checkouts ORDER BY project_id",
          )
          .all(),
      ).toEqual([
        {
          project_id: "duplicate-root",
          local_root: "old-local-root",
          execution_environment: "unknown",
        },
        { project_id: "project", local_root: "old-local-root", execution_environment: "unknown" },
      ]);
      const author = migrated
        .prepare(
          "SELECT participant_id, logical_author_id, author_display_name_snapshot, message FROM task_comments WHERE id = 'comment'",
        )
        .get() as { logical_author_id: string } | undefined;
      expect(author).toMatchObject({
        participant_id: "local-user",
        logical_author_id: expect.any(String),
        author_display_name_snapshot: "Original owner",
        message: "Keep comment",
      });
      expect(author?.logical_author_id).not.toBe("local-user");
      expect(
        migrated.prepare("SELECT logical_participant_id FROM handoff_task_assignments").get(),
      ).toEqual({ logical_participant_id: author?.logical_author_id });
      expect(
        migrated.prepare("SELECT participant_id FROM handoff_participant_bindings").get(),
      ).toEqual({ participant_id: "local-user" });
      expect(migrated.prepare("SELECT participant_id FROM task_assignments").get()).toEqual({
        participant_id: "local-user",
      });
      expect(
        JSON.stringify(migrated.prepare("SELECT * FROM handoff_participants").all()),
      ).not.toContain("password-must-stay-local");
      expect(migrated.prepare("SELECT password_hash FROM participants").get()).toEqual({
        password_hash: "password-must-stay-local",
      });
      migrated.close();
    } finally {
      closeDb();
      for (const connection of connections) if (connection.open) connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
