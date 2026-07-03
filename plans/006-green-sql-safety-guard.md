# Plan 006: Annotate the 7 safe SQL sites so `lint-sql-safety.sh` passes and can become a blocking CI gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- packages/db/src/migrate.ts apps/agent/src/services/process-watcher.ts apps/agent/src/testing/isolated-pg-schema.ts scripts/lint-sql-safety.sh`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. In particular, re-run
> `bash scripts/lint-sql-safety.sh` and confirm the reported line numbers still
> match the seven listed below — the annotations are line-anchored.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

The repo ships `scripts/lint-sql-safety.sh`, a grep guard whose entire purpose is
to catch raw SQL string interpolation of request data (SQL-injection prevention).
Today it reports **7 violations and always exits 1** — so it cannot be wired as a
blocking CI gate (Plan 013 wants to do exactly that), and a guard that always
fails gets ignored or deleted. All 7 flagged sites are **verified safe**: every
interpolated value is a Drizzle table object, a postgres.js identifier fragment
derived from a hardcoded/config schema name, or a test-only generated schema name
— **none is request data, and no request-data SQL injection exists in this repo
today**. The fix is to annotate each safe site with the `// SAFE: <reason>` marker
the script already recognizes, turning the guard green so it becomes a trustworthy,
enforceable control that will fire on a *future* genuine request-data interpolation.

## Current state

The guard's exclusion is **line-scoped**: it greps for SQL keyword + `${` and then
drops any matched line that contains the literal substring `// SAFE:` (see
`scripts/lint-sql-safety.sh:44-56`, the `grep -v '// SAFE:'` stage). Therefore the
annotation **MUST sit on the exact flagged physical line** — a comment on the line
*above* does NOT work (verified empirically against the script's grep pipeline).

This creates two placement cases:

- **Single-line site** (the whole `\`...\`` closes on the flagged line): append a
  normal trailing JS line comment after the statement, e.g. `...\`); // SAFE: ...`.
- **Interior line of a multi-line template literal**: the flagged line is *inside*
  backticks, so a bare `//` there would be sent to Postgres as literal text and is
  **not** a valid SQL comment (Postgres has no `//` comment) — it would break the
  query. Use an SQL **block comment that embeds the marker**:
  `/*// SAFE: <reason> */`. This is valid SQL (Postgres ignores `/* ... */`),
  Postgres-inert, and contains the `// SAFE:` substring the grep drops.

  Inside a JS template literal, the comment text is still JS — so the reason text
  **MUST NOT contain** `${`, a backtick, or `*/`, or it will re-interpolate / close
  the comment. Keep the reason plain ASCII words only.

Do NOT rewrite any SQL logic, do NOT switch to the query builder, do NOT reformat —
only add the seven annotations.

### The 7 sites

Current output of `bash scripts/lint-sql-safety.sh` (all 7 are the work items):

```
apps/agent/src/services/process-watcher.ts:878:            SELECT id FROM ${processWatcherState}
apps/agent/src/testing/isolated-pg-schema.ts:80:  await adminSql.unsafe(`CREATE SCHEMA "${schema}"`);
apps/agent/src/testing/isolated-pg-schema.ts:97:        await adminSql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
packages/db/src/migrate.ts:114:  await client`CREATE SCHEMA IF NOT EXISTS ${schema}`;
packages/db/src/migrate.ts:116:    CREATE TABLE IF NOT EXISTS ${schema}.__drizzle_migrations (
packages/db/src/migrate.ts:123:    SELECT created_at FROM ${schema}.__drizzle_migrations
packages/db/src/migrate.ts:196:    await tx`INSERT INTO ${schema}.__drizzle_migrations (hash, created_at)
```

**Why each is safe** (confirmed by reading the source at commit `64a206ff`):

- `packages/db/src/migrate.ts` lines 114/116/123/196 — `schema` is
  `client(migrationsSchema)` / `tx(migrationsSchema)` (`migrate.ts:113,162`), a
  postgres.js **identifier fragment**. `migrationsSchema` defaults to the hardcoded
  `"drizzle"` (`migrate.ts:107`) and is only ever overridden by tests to an isolated
  schema — it is migration bookkeeping, never request data. The user-supplied values
  in the same templates (`${migration.hash}`, `${migration.folderMillis}` at line 197)
  are proper postgres.js **parameters**, not string-interpolated.
- `apps/agent/src/services/process-watcher.ts:878` — `processWatcherState` is a
  **Drizzle table object** interpolated inside a Drizzle `sql\`...\`` tagged template
  (opens at line 877). Drizzle serializes it to a safe identifier; there is no request
  data anywhere in this DELETE.
- `apps/agent/src/testing/isolated-pg-schema.ts:80,97` — `schema` is a **test-only
  generated name**: `` `nx_${label}_${Date.now()}_${Math.floor(Math.random()*1e6)}` ``
  (line 73). This file lives under `src/testing/` and is only imported by tests
  (`apps/agent/src/routes/projects-update.test.ts`, `.../sessions.test.ts`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| SQL-safety guard | `bash scripts/lint-sql-safety.sh` (or `pnpm lint:sql-safety`) | `lint-sql-safety: OK (no raw SQL interpolation found)`, exit 0 |
| Typecheck (all) | `pnpm typecheck` | exit 0, no errors |
| Typecheck (db only, faster) | `cd packages/db && pnpm typecheck` | exit 0 |
| Migrator integration test | `cd packages/db && POSTGRES_URL="$POSTGRES_URL" bun test src/migrate.test.ts` | pass (or `skip` if `POSTGRES_URL` unset) |
| Agent PG-integration tests (exercise the annotated SQL) | `cd apps/agent && NEXUS_ATTACH_SECRET=test POSTGRES_URL="$POSTGRES_URL" bun test src/services/process-watcher.integration.test.ts src/routes/sessions.test.ts` | pass (or `skip` if `POSTGRES_URL` unset) |

> `POSTGRES_URL` and `NEXUS_ATTACH_SECRET=test` are required for the PG-integration
> tests; without `POSTGRES_URL` those suites `skip` cleanly (they are `describe.skip`
> when the var is unset — see `migrate.test.ts:29-30`). Never run against the shared
> homelab DB with a schema-mutating flow; use a throwaway/local Postgres.

## Scope

**In scope** (the only files you may modify):
- `packages/db/src/migrate.ts` — add 4 annotations (lines 114, 116, 123, 196)
- `apps/agent/src/services/process-watcher.ts` — add 1 annotation (line 878)
- `apps/agent/src/testing/isolated-pg-schema.ts` — add 2 annotations (lines 80, 97)
- `plans/README.md` — status-row update only, if the file exists

**Out of scope** (do NOT touch):
- `scripts/lint-sql-safety.sh` — do NOT change the guard itself. Teaching it to
  auto-skip Drizzle/postgres.js tagged identifiers is a **deferred follow-up** (see
  Maintenance notes), not part of this plan.
- Any SQL logic, query structure, or query-builder migration.
- Any other file the guard does not flag.

## Git workflow

- Branch: `advisor/006-green-sql-safety`
- Single logical commit; message style: conventional commits, e.g.
  `chore(db): annotate safe SQL interpolation sites for lint-sql-safety guard`
  (use `fix(db):` only if you consider re-enabling the guard a fix). Example from
  `git log`: `chore(db): ...` / `fix(db): ...`.
- Do NOT push or open a PR.

## Steps

### Step 1: Annotate the 3 single-line sites (trailing JS comment)

These lines close their template on the same line, so append a normal `// SAFE:`
comment after the statement.

`packages/db/src/migrate.ts:114` — from:
```ts
  await client`CREATE SCHEMA IF NOT EXISTS ${schema}`;
```
to:
```ts
  await client`CREATE SCHEMA IF NOT EXISTS ${schema}`; // SAFE: schema is a postgres.js identifier fragment (migration bookkeeping schema, default "drizzle"), never request data
```

`apps/agent/src/testing/isolated-pg-schema.ts:80` — from:
```ts
  await adminSql.unsafe(`CREATE SCHEMA "${schema}"`);
```
to:
```ts
  await adminSql.unsafe(`CREATE SCHEMA "${schema}"`); // SAFE: schema is a test-only generated name (nx_<label>_<ts>_<rand>, line 73), never request data
```

`apps/agent/src/testing/isolated-pg-schema.ts:97` — from:
```ts
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
```
to:
```ts
        await adminSql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); // SAFE: schema is a test-only generated name (nx_<label>_<ts>_<rand>, line 73), never request data
```

**Verify**: `bash scripts/lint-sql-safety.sh` → the two `isolated-pg-schema.ts`
lines and `migrate.ts:114` no longer appear (4 violations remain, all in `migrate.ts`
lines 116/123/196 and `process-watcher.ts:878`).

### Step 2: Annotate the 4 interior template-literal sites (inline SQL block comment)

These lines are inside a multi-line backtick template, so use `/*// SAFE: ... */`
(valid Postgres block comment, contains the marker). Keep the reason free of `${`,
backticks, and `*/`.

`packages/db/src/migrate.ts:116` — from:
```ts
    CREATE TABLE IF NOT EXISTS ${schema}.__drizzle_migrations (
```
to:
```ts
    CREATE TABLE IF NOT EXISTS ${schema}.__drizzle_migrations ( /*// SAFE: schema is a postgres.js identifier fragment (migration bookkeeping schema), not request data */
```

`packages/db/src/migrate.ts:123` — from:
```ts
    SELECT created_at FROM ${schema}.__drizzle_migrations
```
to:
```ts
    SELECT created_at FROM ${schema}.__drizzle_migrations /*// SAFE: schema is a postgres.js identifier fragment (migration bookkeeping schema), not request data */
```

`packages/db/src/migrate.ts:196` — from:
```ts
    await tx`INSERT INTO ${schema}.__drizzle_migrations (hash, created_at)
```
to:
```ts
    await tx`INSERT INTO ${schema}.__drizzle_migrations (hash, created_at) /*// SAFE: schema is a postgres.js identifier fragment; hash and folderMillis on the next line are bound parameters, not request data */
```

`apps/agent/src/services/process-watcher.ts:878` — from:
```ts
            SELECT id FROM ${processWatcherState}
```
to:
```ts
            SELECT id FROM ${processWatcherState} /*// SAFE: processWatcherState is a Drizzle table object, not request data */
```

**Verify**: `bash scripts/lint-sql-safety.sh` → prints
`lint-sql-safety: OK (no raw SQL interpolation found)` and exits 0.

### Step 3: Confirm nothing else regressed

**Verify**:
- `pnpm typecheck` → exit 0 (comments are type-inert; this confirms no stray
  syntax error, e.g. an accidental early `*/` or an unbalanced backtick).
- `git status` → only the three source files (and optionally `plans/README.md`)
  are modified.

### Step 4: Prove the added SQL comments are Postgres-inert (runtime evidence)

The interior annotations become part of the SQL string sent to Postgres, so a
source read is not sufficient — run the integration tests that execute these exact
statements. If a local/throwaway `POSTGRES_URL` is available:

**Verify**:
- `cd packages/db && POSTGRES_URL="$POSTGRES_URL" bun test src/migrate.test.ts`
  → pass (exercises `selfHealingMigrate` → the CREATE SCHEMA / CREATE TABLE /
  SELECT / INSERT templates you annotated).
- `cd apps/agent && NEXUS_ATTACH_SECRET=test POSTGRES_URL="$POSTGRES_URL" bun test src/services/process-watcher.integration.test.ts src/routes/sessions.test.ts`
  → pass (exercises the process-watcher prune DELETE and the isolated-schema
  CREATE/DROP).

If no Postgres is reachable, these suites `skip` — record that the lint + typecheck
gates passed and that the SQL tests were skipped for lack of a DB (do NOT point them
at the shared homelab DB).

## Test plan

No new tests. The change adds only comments; existing integration tests
(`packages/db/src/migrate.test.ts`, `apps/agent/src/services/process-watcher.integration.test.ts`,
`apps/agent/src/routes/sessions.test.ts`) already execute every annotated statement
against real Postgres and are the regression coverage — re-running them (Step 4)
proves the embedded `/* ... */` comments are inert. Do not add per-comment tests
(the guard's own green run is the check for the annotation itself).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bash scripts/lint-sql-safety.sh` prints `lint-sql-safety: OK (no raw SQL interpolation found)` and exits 0
- [ ] `pnpm typecheck` exits 0
- [ ] `git grep -n "// SAFE:" packages/db/src/migrate.ts apps/agent/src/services/process-watcher.ts apps/agent/src/testing/isolated-pg-schema.ts` shows exactly 7 annotated lines (4 + 1 + 2)
- [ ] Migrator + agent PG-integration tests pass, OR are recorded as skipped because `POSTGRES_URL` was unavailable (Step 4)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (if the file exists)

## STOP conditions

Stop and report back (do not improvise) if:

- The line numbers reported by `bash scripts/lint-sql-safety.sh` no longer match
  the seven in "Current state" (the files drifted since commit `64a206ff`) —
  re-locate each site by its surrounding code before annotating; if a flagged site
  is genuinely new and interpolates **request data**, that is a real finding: STOP
  and report it, do NOT annotate it `// SAFE:`.
- `pnpm typecheck` fails after adding a comment (likely an accidental `*/`,
  backtick, or `${` inside a block-comment reason) — fix the comment text; if it
  fails twice, STOP.
- A migrator or process-watcher integration test that passed before your change now
  fails (a comment is not inert as expected) — STOP and report.
- The guard still reports a violation you cannot resolve by adding `// SAFE:` on the
  exact flagged line (e.g. the script's grep logic differs from this plan's model) —
  STOP; do not edit `scripts/lint-sql-safety.sh` to force green.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **Enables Plan 013**: this plan is a prerequisite for wiring
  `scripts/lint-sql-safety.sh` as a **blocking** CI gate. Land 006 first, else 013
  makes CI permanently red.
- **Reviewer scrutiny**: confirm each `// SAFE:` reason truthfully names a
  non-request-data source (Drizzle table object / postgres.js identifier fragment /
  test-only generated name). The marker is a security assertion — a wrong one hides a
  real injection. The guard is intentionally coarse (line-scoped grep); these
  annotations are the sanctioned escape hatch.
- **Deferred follow-up (out of scope here)**: the guard trips on `client\`...\`` /
  `tx\`...\`` postgres.js tags and on continuation lines of Drizzle `sql\`...\``
  templates because its `grep -v 'sql\`'` exclusion is a single-line substring match.
  A cleaner long-term fix is to teach `scripts/lint-sql-safety.sh` to recognize
  tagged-template identifier interpolation across lines (or to treat `client\``/`tx\``
  like `sql\``), which would let several of these annotations be removed. File that as
  its own change; do not fold it into this plan.
- If a future edit adds a new interpolated statement to any of these templates, the
  new line will trip the guard and must get its own `// SAFE:` (or, if it carries
  request data, be rewritten to a bound parameter — never annotated away).
