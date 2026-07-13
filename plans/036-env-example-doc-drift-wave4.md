# Plan 036: Document 6 operator-facing env vars missing from .env.example (retention-days + poll-intervals)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED, append
> `spec-impact: none` (this plan is documentation-only; it does not implement
> or change any OpenSpec-tracked behavior).
>
> **Drift check (run first)**:
> `git diff --stat 089e0338..HEAD -- .env.example apps/agent/src/db/retention.ts apps/agent/src/services/tailscale-presence.ts apps/agent/src/services/credential-usage-poller.ts`
> At planning time (repo HEAD `6796f8ab`, one commit past the audited
> `089e0338`) this showed only `apps/agent/src/db/retention.ts` touched (+74/-1
> — the commit that introduced `CREDENTIALS_RETENTION_DAYS`, confirmed still
> present at HEAD). `.env.example` and the two poll-interval source files were
> untouched. If your drift check shows anything different — especially any
> change to `.env.example` itself — compare the "Current state" excerpts below
> against the live file before proceeding; on a mismatch, treat it as a STOP
> condition. Leo works directly in this checkout; expect `main` to have moved
> again by the time you run this.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `089e0338`, 2026-07-13 (repo HEAD at plan-authoring time: `6796f8ab`)

## Why this matters

`.env.example` is this repo's sole env-var documentation surface (no
`createEnv`-style validator exists) and it has an established, actively
honored per-feature convention: every new operator-tunable env var gets one
commented block (description + default) at the point a feature introduces it.
Six real, currently-read vars have accumulated without that documentation,
each read via the exact same `process.env.X ?? "<default>"` pattern as
siblings that already ARE documented two lines away — an operator reading the
file today cannot discover these four retention knobs or two poll intervals
exist at all, and would have to read `retention.ts` / `tailscale-presence.ts`
/ `credential-usage-poller.ts` source to find them. This is a live, verified
gap: a fresh run of `~/.claude/scripts/bin/audit-scan --project . --json`
(H1 check) at repo HEAD shows **16** "used in source but missing from
.env.example" findings; 6 of those 16 are the vars this plan documents.

**Important context on 2 of the 6 (read before touching poll intervals):**
`plans/022-env-example-drift-reconciliation.md` (DONE, 2026-07-05) originally
placed `NEXUS_TAILSCALE_POLL_MS` and `NEXUS_USAGE_POLL_INTERVAL_MS` on an
explicit "settled do-not-document" list, alongside `NEXUS_PHONE_PEER` /
`NEXUS_PRESENCE_USER`, as "a separate judgment call — they may belong in ops
docs, not operator examples" (see that plan's Maintenance notes). **This
wave's audit explicitly revisits and supersedes that deferral for these two
poll-interval vars specifically** — they are real, operator-facing tunables
with the identical shape as the already-documented `HEALTH_PUSH_INTERVAL_MS`
(`.env.example:40-42`), and documenting them closes real drift rather than
re-litigating a settled call. `NEXUS_PHONE_PEER` and `NEXUS_PRESENCE_USER`
remain on the do-not-document list — that part of plan 022's deferral is
**not** superseded and is explicitly out of scope here (see Scope below).

## Current state

All excerpts below are fresh reads at repo HEAD `6796f8ab` (one commit past
the planned-at SHA `089e0338`; the only delta is `retention.ts` gaining
`CREDENTIALS_RETENTION_DAYS`, confirmed present — see drift check above).

### File roles

- `.env.example` — the only file this plan modifies. 183 lines at HEAD, no
  vars added or removed by anyone else since planning.
- `apps/agent/src/db/retention.ts` — READ-ONLY context. Declares the 4
  retention-day vars this plan documents, at lines 40–57.
- `apps/agent/src/services/tailscale-presence.ts` — READ-ONLY context.
  Declares `NEXUS_TAILSCALE_POLL_MS` at line 194.
- `apps/agent/src/services/credential-usage-poller.ts` — READ-ONLY context.
  Declares `NEXUS_USAGE_POLL_INTERVAL_MS` at line 305 (NOT
  `apps/agent/src/credentials/credential-usage-poller.ts` — that path does
  not exist; the file lives under `src/services/`).

### `.env.example:38-60` — the two anchor blocks, as they exist today

```
38	NEXUS_SOCKET=
39
40	# Optional: Interval between APNs health-push wakeups in ms (default: 1800000 = 30 min).
41	# Read by apps/agent/src/health-push/health-push-scheduler.ts.
42	HEALTH_PUSH_INTERVAL_MS=
43
44	# Optional: MX sidecar gateway base URL (default: http://127.0.0.1:8799).
45	# Read by apps/agent/src/routes/{sources,triage,thread}.ts.
46	MX_GATEWAY_URL=
47
48	# Optional: Number of days to retain health history in the database (default: 30)
49	HEALTH_RETENTION_DAYS=30
50
51	# Optional: Retention windows for cron-run / bloat-radar / spec-session telemetry
52	# (days). Read by apps/agent/src/db/retention.ts.
53	CRON_RUNS_RETENTION_DAYS=90
54	BLOAT_RADAR_RETENTION_DAYS=90
55	SPEC_SESSIONS_RETENTION_DAYS=365
56
57	# Optional: Per-channel timeout for external notification delivery in ms (default: 10000).
58	# Wraps each channel handler (slack/desktop/tts) with an end-to-end budget; on timeout
59	# emits Sentry captureException and returns a structured failure.
60	NEXUS_NOTIFICATION_TIMEOUT_MS=10000
```

You will insert a new poll-interval block after line 42 (before the blank
line that precedes `MX_GATEWAY_URL`... no — insert it using the existing
blank line 43 as the separator, then add your own trailing blank before the
`MX_GATEWAY_URL` comment resumes). You will append to the retention block
ending at line 55, before its trailing blank line 56.

### `apps/agent/src/db/retention.ts:40-58` — the 4 retention vars (READ-ONLY)

```ts
40	const SPEC_SNAPSHOTS_RETENTION_DAYS = Number(
41	  process.env.SPEC_SNAPSHOTS_RETENTION_DAYS ?? "90",
42	);
43	const PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS = Number(
44	  process.env.PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS ?? "90",
45	);
46	// Per add-git-status-orbit: 90-day window mirrors cron_runs/project_status_
47	// snapshots — long enough for orbital git-history review, short enough to keep
48	// the append-only event table small. Override via env for ops sweeps.
49	const GIT_EVENTS_RETENTION_DAYS = Number(
50	  process.env.GIT_EVENTS_RETENTION_DAYS ?? "90",
51	);
52	// Per nx-lp8v/nx-m5q6 (credentials table bloat — 2,709 rows / 4.03MB payload
53	// with only 1 isActive): mirrors credential_events' 30-day precedent above.
54	// Deliberately conservative — see the predicate comment on
55	// deleteStaleCredentials() for exactly which rows this window applies to.
56	const CREDENTIALS_RETENTION_DAYS = Number(
57	  process.env.CREDENTIALS_RETENTION_DAYS ?? "30",
58	);
```

`CREDENTIALS_RETENTION_DAYS` is NOT a simple "keep telemetry N days" knob like
its 3 siblings — `deleteStaleCredentials()` (same file, ~line 90) only
deletes a `credentials` row when it is past this window AND `leased_by IS
NULL` AND (`status = 'refresh_failed'` OR `is_primary = false`). An operator
who reads only a generic comment could wrongly assume this var prunes ALL
old credential rows unconditionally — the doc comment you write in Step 2
must convey the conditional scope, not just "retention window in days".

### `apps/agent/src/services/tailscale-presence.ts:40-41,194` — poll var #1 (READ-ONLY)

```ts
40	/** Default poll interval (a few seconds). Override via `NEXUS_TAILSCALE_POLL_MS`. */
41	const DEFAULT_INTERVAL_MS = 5_000;
...
194	  const envInterval = Number(process.env.NEXUS_TAILSCALE_POLL_MS);
```

Default: 5000 ms (5 seconds).

### `apps/agent/src/services/credential-usage-poller.ts:38-39,303-307` — poll var #2 (READ-ONLY)

```ts
38	/** Default poll interval. Overridable via `NEXUS_USAGE_POLL_INTERVAL_MS`. */
39	const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
...
303	  const intervalMs =
304	    opts.intervalMs ??
305	    (process.env.NEXUS_USAGE_POLL_INTERVAL_MS
306	      ? Number.parseInt(process.env.NEXUS_USAGE_POLL_INTERVAL_MS, 10)
307	      : DEFAULT_INTERVAL_MS);
```

Default: 300000 ms (5 minutes).

### Live H1 baseline (runtime evidence, captured at repo HEAD `6796f8ab`)

```
$ ~/.claude/scripts/bin/audit-scan --project . --json | python3 -c "
import json,sys
d = json.load(sys.stdin)
h1 = [x['message'] for x in d['findings'] if x['id']=='H1']
print(len(h1))
for m in sorted(h1): print(m)
"
16
Env var COLUMNS used in source but missing from .env.example
Env var CREDENTIALS_RETENTION_DAYS used in source but missing from .env.example
Env var GIT_EVENTS_RETENTION_DAYS used in source but missing from .env.example
Env var NEXUS_HEAVY_TESTS used in source but missing from .env.example
Env var NEXUS_PG_TESTS used in source but missing from .env.example
Env var NEXUS_PHONE_PEER used in source but missing from .env.example
Env var NEXUS_PRESENCE_USER used in source but missing from .env.example
Env var NEXUS_REPO_ROOT used in source but missing from .env.example
Env var NEXUS_RUN_LIVE_REAPER_TESTS used in source but missing from .env.example
Env var NEXUS_SKIP_SCHEMA_CHECK used in source but missing from .env.example
Env var NEXUS_TAILSCALE_POLL_MS used in source but missing from .env.example
Env var NEXUS_USAGE_POLL_INTERVAL_MS used in source but missing from .env.example
Env var NX_BUNDLE_DERIVED_DATA used in source but missing from .env.example
Env var PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS used in source but missing from .env.example
Env var SPEC_SNAPSHOTS_RETENTION_DAYS used in source but missing from .env.example
Env var USER used in source but missing from .env.example
```

After this plan lands, exactly the 6 vars this plan owns (`CREDENTIALS_RETENTION_DAYS`,
`GIT_EVENTS_RETENTION_DAYS`, `NEXUS_TAILSCALE_POLL_MS`,
`NEXUS_USAGE_POLL_INTERVAL_MS`, `PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS`,
`SPEC_SNAPSHOTS_RETENTION_DAYS`) should disappear from this list, leaving
exactly **10**: `COLUMNS`, `NEXUS_HEAVY_TESTS`, `NEXUS_PG_TESTS`,
`NEXUS_PHONE_PEER`, `NEXUS_PRESENCE_USER`, `NEXUS_REPO_ROOT`,
`NEXUS_RUN_LIVE_REAPER_TESTS`, `NEXUS_SKIP_SCHEMA_CHECK`,
`NX_BUNDLE_DERIVED_DATA`, `USER` — all deliberately-excluded per plan 022 /
this plan's Scope section. Do NOT document any of those 10.

### Repo facts (this repo is NOT standard T3)

- pnpm + Bun monorepo, no tRPC. Per `.claude/project.toml`, the quality gates
  are `db = pnpm --filter @nexus/db typecheck`,
  `api = pnpm --filter @nexus/agent typecheck`,
  `ui = pnpm --filter @nexus/statusline typecheck`, `e2e = bun test`.
- This plan touches ONLY `.env.example` (a plain-text doc file, not compiled,
  not imported by any package) — none of the 4 typecheck/test gates above
  are load-bearing for this change; they exist to catch code regressions,
  and no code changes. Still worth a baseline sanity check (Step 1) so any
  pre-existing failure isn't misattributed to you.
- Known pre-existing baseline failure at planning time (unrelated,
  concurrent-session drift — confirmed via fresh run):
  `pnpm --filter @nexus/agent typecheck` exits 2 with 2 `TS2345` errors in
  `src/services/credential-refresh-job.test.ts:297` and
  `src/services/statusline-usage-file.test.ts:110` (both:
  `Property 'updateSecret' is missing in type '...' but required in type
  'WatcherPool'`) — these are test-double shape mismatches from in-flight
  work on `active-credential-watcher.ts` (visible as uncommitted
  modifications in `git status` at planning time), nothing to do with
  `.env.example`. Do not attempt to fix them; they are out of scope.
- Migration policy (not relevant here — no schema touched): migration-based
  only, `db:generate` + commit + deploy `db:migrate`, never `db:push`.

## Commands you will need

| Purpose | Command (run from repo root) | Expected on success |
|---------|------------------------------|---------------------|
| Drift check | `git diff --stat 089e0338..HEAD -- .env.example apps/agent/src/db/retention.ts apps/agent/src/services/tailscale-presence.ts apps/agent/src/services/credential-usage-poller.ts` | only `retention.ts` shown changed (see Drift check note above); `.env.example` untouched |
| H1 count | `~/.claude/scripts/bin/audit-scan --project . --json \| python3 -c "import json,sys; d=json.load(sys.stdin); h1=[x['message'] for x in d['findings'] if x['id']=='H1']; print(len(h1)); [print(m) for m in sorted(h1)]"` | before: 16 (list above); after: 10, none of the 6 owned vars present |
| Owned-var count | `grep -Ec "^(SPEC_SNAPSHOTS_RETENTION_DAYS\|PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS\|GIT_EVENTS_RETENTION_DAYS\|CREDENTIALS_RETENTION_DAYS\|NEXUS_TAILSCALE_POLL_MS\|NEXUS_USAGE_POLL_INTERVAL_MS)=" .env.example` | before: `0`; after: `6` |
| Excluded-var guard | `grep -c "^NEXUS_PHONE_PEER=\|^NEXUS_PRESENCE_USER=" .env.example` | `0`, both before and after |
| No-op sanity check | `pnpm --filter @nexus/agent typecheck 2>&1 \| tail -5` | same 2 pre-existing `TS2345` errors before and after (unrelated to your change — do not attempt to fix) |

## Scope

**In scope** (the only file you may modify):

- `.env.example` — 2 insertions (Steps 2 and 3 below)
- `plans/README.md` — your status row on completion

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/db/retention.ts` — read-only context; you are documenting
  existing reads, not adding or changing any.
- `apps/agent/src/services/tailscale-presence.ts`,
  `apps/agent/src/services/credential-usage-poller.ts` — read-only context.
- `deploy/secrets.env.example` — a different file with a different purpose
  (production secrets); none of these 6 vars belong there.
- **`NEXUS_PHONE_PEER`, `NEXUS_PRESENCE_USER`** — still on plan 022's settled
  do-not-document list (that part of the deferral is NOT superseded by this
  plan — only the 2 poll-interval vars are). Adding either is a scope
  violation, not an omission to fix.
- **`NEXUS_HEAVY_TESTS`, `NEXUS_PG_TESTS`, `NEXUS_RUN_LIVE_REAPER_TESTS`,
  `NEXUS_SKIP_SCHEMA_CHECK`** — test-gate flags, test-only usage.
- **`NX_BUNDLE_DERIVED_DATA`, `NEXUS_REPO_ROOT`** — dev/build-infra knobs,
  deliberately deferred by plan 022 (a separate ops-docs-vs-operator-examples
  judgment call, still open).
- **`COLUMNS`, `USER`** — POSIX ambient vars, never operator-set.
- Building a docs-sweep enforcement gate (a pre-commit or CI check that greps
  new `process.env.X` reads against `.env.example`) — this is a separate,
  larger tooling decision that should be raised to Leo on its own; do not
  build it as part of this plan.
- Any change to how `retention.ts`, `tailscale-presence.ts`, or
  `credential-usage-poller.ts` read or default these vars — this plan only
  documents existing, already-shipped behavior.

## Git workflow

- This plan may execute in a worktree (Leo works directly in
  `~/dev/personal/nexus`; expect `main` to advance mid-execution — see the
  concurrent-session note in Repo facts).
- Branch: `advisor/036-env-example-doc-drift-wave4` (matches the fleet
  convention, e.g. `advisor/030-...`).
- Single commit, conventional style, message written to a temp file and
  applied via `git commit -F` (never a HEREDOC chained with `&&`). Example
  subject: `docs(env): document retention-day + poll-interval vars in .env.example (plan 036)`
- Stage ONLY `.env.example` (and `plans/README.md` if you update it in the
  same commit) by explicit path. Never `git add .` or `git add -A`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Capture baselines

From the repo root, run the drift check, the H1 count, the owned-var count,
the excluded-var guard, and the no-op sanity typecheck (all from "Commands
you will need"). Save the H1 list and the typecheck error output.

**Verify**: drift check → only `retention.ts` shown changed since
`089e0338` (or nothing, if you're running exactly at that SHA); H1 count →
`16` with all 6 owned vars present in the list; owned-var count → `0`;
excluded-var guard → `0`; typecheck → exits 2 with exactly the 2 `TS2345`
`WatcherPool`/`updateSecret` errors described above (if you see a DIFFERENT
error set, or errors in `.env.example` consumers, STOP — see STOP conditions).

### Step 2: Insert the 2 poll-interval vars beside `HEALTH_PUSH_INTERVAL_MS`

Edit `.env.example`. Immediately after the `HEALTH_PUSH_INTERVAL_MS=` line
(line 42 in the excerpt above), using the existing blank line 43 as the
leading separator, insert:

```
# Optional: Tailscale presence poll interval in ms (default: 5000 = 5s).
# Read by apps/agent/src/services/tailscale-presence.ts.
NEXUS_TAILSCALE_POLL_MS=

# Optional: Credential-usage poller interval in ms (default: 300000 = 5 min).
# Read by apps/agent/src/services/credential-usage-poller.ts.
NEXUS_USAGE_POLL_INTERVAL_MS=
```

followed by a blank line, then the existing `MX_GATEWAY_URL` comment block
resumes unchanged. Do not modify the `HEALTH_PUSH_INTERVAL_MS` or
`MX_GATEWAY_URL` entries or their comments.

**Verify**:
`grep -n "^NEXUS_TAILSCALE_POLL_MS=\|^NEXUS_USAGE_POLL_INTERVAL_MS=" .env.example`
→ exactly 2 matches, both between the `HEALTH_PUSH_INTERVAL_MS` line and the
`MX_GATEWAY_URL` line.

### Step 3: Append the 4 retention-day vars to the existing retention block

Edit `.env.example`. The existing block (lines 51–55 in the excerpt above)
reads:

```
# Optional: Retention windows for cron-run / bloat-radar / spec-session telemetry
# (days). Read by apps/agent/src/db/retention.ts.
CRON_RUNS_RETENTION_DAYS=90
BLOAT_RADAR_RETENTION_DAYS=90
SPEC_SESSIONS_RETENTION_DAYS=365
```

Change the comment to cover the two additional plain retention-day vars that
share the identical shape, and append them:

```
# Optional: Retention windows for cron-run / bloat-radar / spec-session /
# spec-snapshot / project-status-snapshot / git-event telemetry (days).
# Read by apps/agent/src/db/retention.ts.
CRON_RUNS_RETENTION_DAYS=90
BLOAT_RADAR_RETENTION_DAYS=90
SPEC_SESSIONS_RETENTION_DAYS=365
SPEC_SNAPSHOTS_RETENTION_DAYS=90
PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS=90
GIT_EVENTS_RETENTION_DAYS=90
```

Then, still inside `.env.example`, insert a new standalone block directly
after that (before the blank line that precedes the
`NEXUS_NOTIFICATION_TIMEOUT_MS` comment) — `CREDENTIALS_RETENTION_DAYS` gets
its own block because it is conditional, not a blanket "delete rows older
than N days":

```
# Optional: Retention window (days) for stale `credentials` rows (default: 30).
# Only deletes a row that is BOTH past this window AND has no active lease
# (leased_by IS NULL), AND matches one of: status='refresh_failed', or
# is_primary=false. Never deletes an isPrimary=true row still in 'available'
# status regardless of age. Read by apps/agent/src/db/retention.ts
# (see deleteStaleCredentials()).
CREDENTIALS_RETENTION_DAYS=30
```

Do not modify the existing `CRON_RUNS_RETENTION_DAYS` / `BLOAT_RADAR_RETENTION_DAYS`
/ `SPEC_SESSIONS_RETENTION_DAYS` values or the `HEALTH_RETENTION_DAYS` block
above them.

**Verify**:
`grep -n "^SPEC_SNAPSHOTS_RETENTION_DAYS=\|^PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS=\|^GIT_EVENTS_RETENTION_DAYS=\|^CREDENTIALS_RETENTION_DAYS=" .env.example`
→ exactly 4 matches, all after `SPEC_SESSIONS_RETENTION_DAYS=365` and before
`NEXUS_NOTIFICATION_TIMEOUT_MS=10000`.

### Step 4: Run the full verification battery

Run all 5 commands from "Commands you will need".

**Verify**:
- H1 count → `10`; the sorted list is exactly `COLUMNS`, `NEXUS_HEAVY_TESTS`,
  `NEXUS_PG_TESTS`, `NEXUS_PHONE_PEER`, `NEXUS_PRESENCE_USER`,
  `NEXUS_REPO_ROOT`, `NEXUS_RUN_LIVE_REAPER_TESTS`,
  `NEXUS_SKIP_SCHEMA_CHECK`, `NX_BUNDLE_DERIVED_DATA`, `USER` — none of the 6
  owned vars present.
- Owned-var count → `6`.
- Excluded-var guard → `0` (unchanged).
- Typecheck sanity → same 2 pre-existing `TS2345` errors as your Step-1
  baseline, no new errors.
- `git status --short` → only `.env.example` modified (plus `plans/README.md`
  if you touch it in the same pass).

### Step 5: Commit and update the plan index

Write the commit message to a temp file, `git commit -F` it with
`.env.example` staged by explicit path, then update this plan's row in
`plans/README.md` to DONE with a one-line evidence summary (H1 16→10, 6 vars
documented) and `spec-impact: none`.

**Verify**: `git show --stat HEAD` → `.env.example` changed (plus
`plans/README.md` if committed together, no other files);
`git log -1 --format=%s` → the conventional subject line from Git workflow.

## Test plan

No new tests: this is a pure comment/entry addition to a plain-text example
file with no test harness of its own (nothing imports or parses
`.env.example` at runtime or in CI). The regression guard is the H1 check in
`~/.claude/scripts/bin/audit-scan` — model this plan's verification after
`plans/030-env-doc-residue.md` Step 5, which used the identical
before/after H1-count pattern for a prior `.env.example`-only doc change.

Verification: the H1 count command in "Commands you will need" → `16` before,
`10` after, with the exact 6-vars-gone / 10-vars-remain assertion above. Paste
both the before and after H1 lists in your completion report as the runtime
evidence for this doc-only change.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -Ec "^(SPEC_SNAPSHOTS_RETENTION_DAYS|PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS|GIT_EVENTS_RETENTION_DAYS|CREDENTIALS_RETENTION_DAYS|NEXUS_TAILSCALE_POLL_MS|NEXUS_USAGE_POLL_INTERVAL_MS)=" .env.example` → `6`
- [ ] `grep -c "^NEXUS_PHONE_PEER=\|^NEXUS_PRESENCE_USER=" .env.example` → `0`
- [ ] H1 count via `audit-scan` → `10`, list contains none of the 6 owned vars
- [ ] `pnpm --filter @nexus/agent typecheck` → same 2 pre-existing `TS2345`
      errors as the Step-1 baseline, no new errors
- [ ] `git status --short` shows no modified files outside `.env.example`
      (and `plans/README.md` if updated in the same pass)
- [ ] `plans/README.md` row for 036 updated, with `spec-impact: none` appended

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `.env.example` itself changed since `089e0338` AND
  the "Current state" line-number excerpts no longer match the live file
  (main advances constantly here — a diff alone is not a STOP, an excerpt
  mismatch is).
- The Step-1 H1 baseline is not `16`, or is missing any of the 6 owned vars,
  or already shows fewer than 16 (someone else already documented part of
  this — report the overlap, do not double-apply).
- Your Read/Edit tooling is permission-denied on `.env.example` (plan 022 hit
  `.env*` deny rules twice on this repo; both were fixed globally, but if a
  gate re-appears, report the denial — do NOT bypass via shell redirection
  like `echo >>`).
- The Step-4 H1 count is anything other than `10` after one re-check of your
  edits (a new undocumented var landed mid-execution; it is not yours to
  fix — report it instead of folding it in).
- `~/.claude/scripts/bin/audit-scan` does not exist or errors on this
  machine.
- The Step-1 typecheck baseline shows a DIFFERENT error set than the 2
  `TS2345` `WatcherPool`/`updateSecret` errors described in Repo facts (drift
  in unrelated code), or Step 4 shows any typecheck error not in your
  baseline.
- Fixing anything appears to require editing `retention.ts`,
  `tailscale-presence.ts`, `credential-usage-poller.ts`, or any other
  out-of-scope file.
- Anyone or anything suggests adding `NEXUS_PHONE_PEER` or
  `NEXUS_PRESENCE_USER` "while you're in there" — that part of plan 022's
  deferral is explicitly NOT superseded by this plan; adding them is a scope
  violation.

## Maintenance notes

- **Reviewer focus**: confirm the diff to `.env.example` is exactly the 2
  new blocks (Step 2) plus the 1 edited comment + 4 new lines (Step 3) — no
  existing var's default value or comment changed; confirm no real secret or
  production value entered the file (all new entries are empty or literal
  documented defaults, matching the file's existing convention).
- **H1 steady state is now 10** (was 16 before this plan; the 10 residual are
  all deliberately-excluded per plan 022 / this plan's Scope section: 4
  test-gate flags, 2 dev/build-infra knobs, `NEXUS_PHONE_PEER` /
  `NEXUS_PRESENCE_USER`, and ambient `COLUMNS`/`USER`). Record: any future H1
  count above 10 is NEW drift, not settled residue.
- **`NEXUS_PHONE_PEER` / `NEXUS_PRESENCE_USER` / `NX_BUNDLE_DERIVED_DATA` /
  `NEXUS_REPO_ROOT`'s long-term documentation fate** remains an open
  ops-docs-vs-operator-examples judgment call per plan 022 — this plan does
  not decide it, only the 2 poll-interval vars' deferral was revisited.
- **A docs-sweep enforcement gate** (grep new `process.env.X` reads against
  `.env.example` at pre-commit or CI time) would stop this whole class of
  drift recurring per-feature. Deliberately not built here — raise it to Leo
  as a separate tooling decision.
- **`CREDENTIALS_RETENTION_DAYS`'s conditional semantics**: if
  `deleteStaleCredentials()`'s predicate in `retention.ts` ever changes (e.g.
  a third qualifying condition is added), the `.env.example` comment written
  in Step 3 must be updated to match — it currently describes exactly 2
  qualifying predicates plus the `leased_by IS NULL` safety belt.
