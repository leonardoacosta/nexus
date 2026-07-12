-- nx-1zfkq: dedupe `projects` rows before adding the partial unique index below.
--
-- Root cause: `projects_name_git_remote_url_unique` on (name, git_remote_url)
-- never catches two rows with the same `name` and a NULL `git_remote_url`,
-- because Postgres treats every NULL as distinct in a unique constraint. The
-- agent's auto-discovery scanner (`upsertProjectLocations` in
-- apps/agent/src/db/project-registry.ts) runs every ~60s and inserts via
-- `INSERT ... ON CONFLICT DO NOTHING` with no explicit conflict target, so it
-- silently inserted a brand-new duplicate row on every cycle for any project
-- with no git remote instead of no-op'ing. Verified live 2026-07-12: 7,168+
-- of 7,309 rows in `projects` were duplicates, some names carrying 2,900+
-- rows, growing continuously since 2026-07-10. No code change is needed in
-- the scanner itself — it already uses a bare `onConflictDoNothing()`, which
-- in Postgres catches ANY unique/exclusion constraint violation (including a
-- partial index) once one exists; the fix is purely this missing index.
--
-- The dedupe below is NOT a naive "keep most recent, delete the rest" — two
-- names (`brown`, `central-planning`) had duplicate rows independently
-- referenced by DIFFERENT `sessions` rows and/or `project_locations` rows
-- (the scanner's non-deterministic `SELECT id ... LIMIT 1` picked a
-- different duplicate project id across different scan cycles). A naive
-- delete would have silently orphaned 278 sessions via
-- `sessions_project_id_projects_id_fk`'s `ON DELETE SET NULL`. This instead:
--   1. Picks one canonical project id per (name, NULL git_remote_url) group
--      — the id with the most combined session+location references, tied
--      broken by most recent `discovered_at`.
--   2. Collapses any duplicate `project_locations` rows sharing the same
--      (name, agent_id) down to the single most-recently-discovered one
--      (avoids violating `project_locations_project_agent_unique` when
--      re-pointing to the canonical id).
--   3. Re-points surviving `project_locations` and `sessions` rows in the
--      group to the canonical project id.
--   4. Deletes every non-canonical duplicate `projects` row.
--
-- Verified in a live transaction (BEGIN; ...; ROLLBACK;) against the
-- production homelab DB on 2026-07-12: 7,222 duplicate `projects` rows
-- removed, `project_locations` count dropped only by the 5 genuine
-- duplicates collapsed (120 -> 115), and `sessions` with a non-null
-- `project_id` was UNCHANGED at 2,482 before and after (zero session data
-- loss). The partial unique index below then created with zero constraint
-- violations against the deduped data.
WITH dup_names AS (
  SELECT name FROM projects WHERE git_remote_url IS NULL GROUP BY name HAVING COUNT(*) > 1
),
ref_counts AS (
  SELECT p.id, p.name, p.discovered_at,
    (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) +
    (SELECT COUNT(*) FROM project_locations l WHERE l.project_id = p.id) AS ref_count
  FROM projects p
  WHERE p.git_remote_url IS NULL AND p.name IN (SELECT name FROM dup_names)
),
ranked AS (
  SELECT id, name,
    ROW_NUMBER() OVER (PARTITION BY name ORDER BY ref_count DESC, discovered_at DESC, id) AS rn
  FROM ref_counts
),
canonical AS (
  SELECT id AS canonical_id, name FROM ranked WHERE rn = 1
),
-- Collapse duplicate project_locations rows per (name, agent_id) to the
-- single most-recently-discovered one, regardless of which duplicate
-- project id they currently point at.
loc_dup AS (
  SELECT l.id AS loc_id,
    ROW_NUMBER() OVER (PARTITION BY p.name, l.agent_id ORDER BY l.last_discovered_at DESC NULLS LAST, l.id DESC) AS rn
  FROM project_locations l
  JOIN projects p ON p.id = l.project_id
  WHERE p.git_remote_url IS NULL AND p.name IN (SELECT name FROM canonical)
)
DELETE FROM project_locations WHERE id IN (SELECT loc_id FROM loc_dup WHERE rn > 1);--> statement-breakpoint

WITH dup_names AS (
  SELECT name FROM projects WHERE git_remote_url IS NULL GROUP BY name HAVING COUNT(*) > 1
),
ref_counts AS (
  SELECT p.id, p.name, p.discovered_at,
    (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) +
    (SELECT COUNT(*) FROM project_locations l WHERE l.project_id = p.id) AS ref_count
  FROM projects p
  WHERE p.git_remote_url IS NULL AND p.name IN (SELECT name FROM dup_names)
),
ranked AS (
  SELECT id, name,
    ROW_NUMBER() OVER (PARTITION BY name ORDER BY ref_count DESC, discovered_at DESC, id) AS rn
  FROM ref_counts
),
canonical AS (
  SELECT id AS canonical_id, name FROM ranked WHERE rn = 1
)
UPDATE project_locations l
SET project_id = c.canonical_id
FROM projects p
JOIN canonical c ON c.name = p.name
WHERE l.project_id = p.id AND p.id <> c.canonical_id AND p.git_remote_url IS NULL;--> statement-breakpoint

WITH dup_names AS (
  SELECT name FROM projects WHERE git_remote_url IS NULL GROUP BY name HAVING COUNT(*) > 1
),
ref_counts AS (
  SELECT p.id, p.name, p.discovered_at,
    (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) +
    (SELECT COUNT(*) FROM project_locations l WHERE l.project_id = p.id) AS ref_count
  FROM projects p
  WHERE p.git_remote_url IS NULL AND p.name IN (SELECT name FROM dup_names)
),
ranked AS (
  SELECT id, name,
    ROW_NUMBER() OVER (PARTITION BY name ORDER BY ref_count DESC, discovered_at DESC, id) AS rn
  FROM ref_counts
),
canonical AS (
  SELECT id AS canonical_id, name FROM ranked WHERE rn = 1
)
UPDATE sessions s
SET project_id = c.canonical_id
FROM projects p
JOIN canonical c ON c.name = p.name
WHERE s.project_id = p.id AND p.id <> c.canonical_id AND p.git_remote_url IS NULL;--> statement-breakpoint

WITH dup_names AS (
  SELECT name FROM projects WHERE git_remote_url IS NULL GROUP BY name HAVING COUNT(*) > 1
),
ref_counts AS (
  SELECT p.id, p.name, p.discovered_at,
    (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) +
    (SELECT COUNT(*) FROM project_locations l WHERE l.project_id = p.id) AS ref_count
  FROM projects p
  WHERE p.git_remote_url IS NULL AND p.name IN (SELECT name FROM dup_names)
),
ranked AS (
  SELECT id, name,
    ROW_NUMBER() OVER (PARTITION BY name ORDER BY ref_count DESC, discovered_at DESC, id) AS rn
  FROM ref_counts
),
canonical AS (
  SELECT id AS canonical_id, name FROM ranked WHERE rn = 1
)
DELETE FROM projects p
USING canonical c
WHERE p.name = c.name AND p.git_remote_url IS NULL AND p.id <> c.canonical_id;--> statement-breakpoint

CREATE UNIQUE INDEX "projects_name_null_remote_unique" ON "projects" USING btree ("name") WHERE "projects"."git_remote_url" IS NULL;