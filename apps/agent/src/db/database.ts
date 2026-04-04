import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { logger } from "@nexus/core";
import { runMigrations } from "./migrate";

const DEFAULT_DB_PATH = join(homedir(), ".config", "nexus", "nexus.db");
const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

/**
 * Open (or create) the Nexus SQLite database with WAL mode and run any
 * pending migrations.
 *
 * @param dbPath Override path — mainly for testing. Defaults to
 *   `~/.config/nexus/nexus.db`.
 * @param migrationsDir Override migrations directory — mainly for testing.
 */
export function openDatabase(
  dbPath: string = DEFAULT_DB_PATH,
  migrationsDir: string = MIGRATIONS_DIR,
): Database {
  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  runMigrations(db, migrationsDir);

  logger.info("database ready", { path: dbPath });
  return db;
}
