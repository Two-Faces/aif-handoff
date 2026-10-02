import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb } from "../db.js";

describe("personal policy migration", () => {
  it("upgrades a populated v29 DB and preserves policy across reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "aif-personal-migrate-"));
    const path = join(root, "db.sqlite");
    closeDb();
    const connections: Database.Database[] = [];
    try {
      getDb(path);
      closeDb();
      const old = new Database(path);
      connections.push(old);
      old.exec("ALTER TABLE projects DROP COLUMN personal_mode");
      old.exec("ALTER TABLE projects DROP COLUMN publication_policy");
      old
        .prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)")
        .run("legacy", "Existing", "local-root");
      old
        .prepare("INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)")
        .run("task", "legacy", "Keep task");
      old.pragma("user_version = 29");
      old.close();
      getDb(path);
      closeDb();
      const migrated = new Database(path);
      connections.push(migrated);
      expect(migrated.pragma("user_version", { simple: true })).toBe(39);
      expect(
        migrated
          .prepare("SELECT personal_mode, publication_policy FROM projects WHERE id = ?")
          .get("legacy"),
      ).toEqual({ personal_mode: 0, publication_policy: "standard" });
      expect(migrated.prepare("SELECT title FROM tasks WHERE id = ?").get("task")).toEqual({
        title: "Keep task",
      });
      migrated
        .prepare(
          "UPDATE projects SET personal_mode = 1, publication_policy = 'local_only' WHERE id = ?",
        )
        .run("legacy");
      migrated.close();
      getDb(path);
      closeDb();
      const restored = new Database(path, { readonly: true });
      connections.push(restored);
      expect(
        restored
          .prepare("SELECT personal_mode, publication_policy FROM projects WHERE id = ?")
          .get("legacy"),
      ).toEqual({ personal_mode: 1, publication_policy: "local_only" });
      restored.close();
    } finally {
      closeDb();
      for (const connection of connections) if (connection.open) connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
