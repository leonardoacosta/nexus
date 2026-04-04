import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@nexus/core";

/**
 * Run pending SQL migrations against the given database.
 *
 * Migrations are numbered SQL files in `migrationsDir` (e.g. `001_init.sql`).
 * Applied migrations are tracked in a `_migrations` table so each file is
 * executed at most once.
 */
export function runMigrations(db: Database, migrationsDir: string): void {
  // Ensure the tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  // Discover migration files sorted by name
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Determine which have already been applied
  const applied = new Set(
    db
      .query("SELECT name FROM _migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf-8");

    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    })();

    logger.info("migration applied", { file });
  }
}
