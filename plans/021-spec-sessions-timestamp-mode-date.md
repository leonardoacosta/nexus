# Plan 021: Add explicit `mode: "date"` to `spec_sessions.created_at` — the sole schema timestamp relying on the implicit default

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c67ff12c..HEAD -- packages/db/src/schema/specSessions.ts packages/db/drizzle/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt (convention consistency)
- **Planned at**: commit `c67ff12c`, 2026-07-05

## Why this matters

`packages/db/src/schema/` contains 50 `timestamp(...)` column definitions.
49 of them pass an explicit `{ mode: "date" }` option; `spec_sessions.created_at`
is the single outlier that relies on drizzle's implicit default. On the
installed drizzle-orm (0.44.7) the implicit default IS date mode — so today
this is a pure convention gap, not a behavior bug (see "Important correction"
below). The value of closing it: the schema reads uniformly, greps for the
convention stop finding one false outlier, and the column's TS type no longer
depends on a library default that could shift across a drizzle major upgrade.

**Important correction (do not "fix" more than this)**: an earlier audit note
claimed drizzle returns this column as `string`. That is FALSE for
drizzle-orm 0.44.7: `timestamp()` without `mode` resolves to
`PgTimestampBuilderInitial` (`data: Date`) at the type level and
`mapFromDriverValue: (value: string) => Date` at runtime (verified in
`node_modules/.../drizzle-orm/pg-core/columns/timestamp.d.ts`). Every consumer
already treats the value as `Date` and the repo typechecks green. This plan is
a one-word explicitness change with **zero expected type ripple**.

## Current state

- `packages/db/src/schema/specSessions.ts` — the `spec_sessions` join table
  (specs ↔ sessions). Lines 36–38 as of `c67ff12c`:

  ```ts
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  ```

- Convention exemplar — `packages/db/src/schema/cronRuns.ts:30`:

  ```ts
  timestamp: timestamp("timestamp", { mode: "date" }).notNull(),
  ```

  Note: siblings vary on `withTimezone` (that is per-column DDL and MUST NOT
  be changed here); the convention being enforced is only the explicit
  `mode: "date"`.

- Consumers of `specSessions.createdAt` (all already `Date`-typed — this is
  the proof the change is a no-op at the type layer):
  - `apps/agent/src/routes/specs/handlers-sessions.ts:52` — local row type
    annotates `createdAt: Date;` and line 95 calls `r.createdAt.toISOString()`.
  - `apps/agent/src/db/retention.ts:81` —
    `.where(lt(specSessions.createdAt, specSessionsCutoff))` with a `Date`
    cutoff (line 60–62).
  - `apps/agent/src/services/session-spec-link.ts:150` — insert path; does not
    set `createdAt` (relies on `defaultNow()`).

- Migration policy (from `.claude/CLAUDE.md`): migration-based ONLY, NEVER
  `db:push`. This plan's premise is that `mode` is a TS-layer option that does
  NOT change DDL — therefore `db:generate` MUST produce no migration. Proving
  that empty diff is a required gate, not optional.

- `packages/db/drizzle.config.ts` throws at load if `POSTGRES_URL` is unset.
  `drizzle-kit generate` itself is offline (never connects), so a dummy URL
  satisfies the config for the generate gate — do NOT point it at the shared
  homelab DB.

- `packages/db/drizzle/` currently contains **47** `.sql` migration files
  (latest: `0046_long_freak.sql`). That count must not change.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` (repo root, only if node_modules missing) | exit 0 |
| Typecheck | `pnpm typecheck` (repo root; runs turbo) | exit 0, no errors |
| Migration no-op proof | `POSTGRES_URL="postgres://dummy:dummy@localhost:5432/dummy" pnpm --filter @nexus/db db:generate` | prints "No schema changes, nothing to migrate"; no new file in `packages/db/drizzle/` |
| Spec-sessions tests | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test handlers-sessions session-spec-link` | all pass, 0 fail |

Notes: Bun monorepo — never run code via `tsc`. `NEXUS_ATTACH_SECRET=test` is
required for agent bun tests. Lint baseline was greened 2026-07-03; if
`pnpm lint` is red, verify no NEW errors are attributable to
`specSessions.ts` before treating it as a failure.

## Scope

**In scope** (the only file you should modify):
- `packages/db/src/schema/specSessions.ts` (one line)

**Out of scope** (do NOT touch, even though they look related):
- `packages/db/src/schema/credentials.ts` — lines 91/97/102 were flagged by
  the same regex scan but ALREADY carry `mode: "date"` on wrapped lines
  (regex blindness, confirmed false positives). Do not edit.
- Any other schema column, any `withTimezone` value, any migration file under
  `packages/db/drizzle/` — if a migration appears, that is a STOP condition,
  not something to commit.
- `apps/agent/src/routes/specs/handlers-sessions.ts`,
  `apps/agent/src/db/retention.ts`,
  `apps/agent/src/services/session-spec-link.ts` — consumers are already
  `Date`-typed; no ripple expected. If typecheck says otherwise, STOP.
- Env example files (`deploy/secrets.env.example`) — nothing here changes env.

## Git workflow

- Work on the **current branch** (no branch creation).
- Single commit, targeted add:
  `git add packages/db/src/schema/specSessions.ts .beads/ && git commit -m "chore(db): explicit mode:'date' on spec_sessions.created_at (last implicit timestamp)" && git push`
- Never `git add .` / `-A` / bare directories.

## Steps

### Step 1: Add `mode: "date"` to the options object

In `packages/db/src/schema/specSessions.ts`, change line 36 from:

```ts
createdAt: timestamp("created_at", { withTimezone: true })
```

to:

```ts
createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
```

Nothing else in the file changes.

**Verify**:
`for f in packages/db/src/schema/*.ts; do perl -0pe 's/\n\s+/ /g' "$f" | grep -n 'timestamp(' | grep -v 'mode: "date"' | sed "s|^|$f: |"; done`
→ prints nothing (previously printed the specSessions.ts site; 50/50 sites now explicit).

### Step 2: Prove the change is DDL-neutral (no migration emitted)

```bash
POSTGRES_URL="postgres://dummy:dummy@localhost:5432/dummy" pnpm --filter @nexus/db db:generate
```

**Verify** (all three):
- Output contains "No schema changes, nothing to migrate".
- `ls packages/db/drizzle/*.sql | wc -l` → `47`
- `git status --porcelain packages/db/drizzle/` → empty output

If a new `.sql` file or snapshot appears: STOP (see STOP conditions), and
`git checkout -- packages/db/drizzle/` is NOT sufficient cleanup — also delete
any untracked generated files before reporting.

### Step 3: Typecheck the ripple (expected: zero)

```bash
pnpm typecheck
```

**Verify**: exit 0. Consumers (`handlers-sessions.ts`, `retention.ts`) already
annotate/compare `Date`, so no errors are expected. Any new error mentioning
`createdAt`, `SpecSession`, or `specSessions` is a STOP condition.

### Step 4: Run the spec-sessions tests

```bash
cd apps/agent && NEXUS_ATTACH_SECRET=test bun test handlers-sessions session-spec-link
```

**Verify**: all tests pass, 0 fail. These cover the session-count-chip read
path (`handlers-sessions.test.ts` — fake rows already use `createdAt: Date`
objects, lines 119–120) and the insert path (`session-spec-link.test.ts`).

### Step 5: Commit and push

```bash
git add packages/db/src/schema/specSessions.ts .beads/
git commit -m "chore(db): explicit mode:'date' on spec_sessions.created_at (last implicit timestamp)"
git push
```

**Verify**: `git status --porcelain` shows no in-scope files left modified;
push exits 0. (If `.beads/` has no changes, `git add` of it is a harmless
no-op — keep the command as written.)

## Test plan

No new tests. Rationale: the change is type-layer-only and provably
behavior-neutral (Step 2's empty migration diff + Step 3's green typecheck are
the machine checks). The existing suites to exercise are:

- `apps/agent/src/routes/specs/handlers-sessions.test.ts` — read path,
  DESC-by-created_at ordering, `created_at` ISO serialization.
- `apps/agent/src/services/session-spec-link.test.ts` — insert path.

If you believe a new test is needed, model it after
`apps/agent/src/routes/specs/handlers-sessions.test.ts` — but the default for
this plan is: run existing tests, add nothing.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c 'mode: "date"' packages/db/src/schema/specSessions.ts` → `1`
- [ ] The Step 1 verify loop (timestamp sites lacking `mode: "date"`) prints nothing
- [ ] `db:generate` printed "No schema changes, nothing to migrate"; `ls packages/db/drizzle/*.sql | wc -l` → `47`; `git status --porcelain packages/db/drizzle/` → empty
- [ ] `pnpm typecheck` exits 0
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test handlers-sessions session-spec-link` → all pass
- [ ] `git diff --name-only HEAD~1` (after commit) lists only `packages/db/src/schema/specSessions.ts` (plus `.beads/` files if any)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **`db:generate` emits ANY new migration or modifies anything under
  `packages/db/drizzle/`.** This falsifies the plan's core premise (`mode` is
  TS-layer only). Do NOT commit the migration, do NOT run `db:migrate`, and
  NEVER `db:push`. Clean up generated files and report.
- `pnpm typecheck` produces any error referencing `createdAt`, `SpecSession`,
  or a file outside the in-scope list — the "zero ripple" claim would be
  wrong; report the exact error instead of patching consumers.
- Lines 36–38 of `specSessions.ts` no longer match the "Current state" excerpt
  (drift since `c67ff12c`).
- The Step 1 verify loop reports a timestamp site in a file OTHER than
  `specSessions.ts` lacking `mode: "date"` — a new column landed since this
  plan; fix only `specSessions.ts` and mention the new outlier in your report
  (do not edit the other file).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If drizzle-orm is upgraded past 0.44.x, the implicit-default question is
  moot after this plan — every timestamp is explicit. Keep it that way: new
  timestamp columns should copy an existing sibling (e.g. `cronRuns.ts:30`).
- Reviewer scrutiny: the diff must be exactly one line in one file, and the
  PR/commit must NOT contain anything under `packages/db/drizzle/`.
- Explicitly deferred: nothing. The audit's other flagged sites
  (`credentials.ts:91/97/102`) were confirmed false positives — do not
  re-audit them.
