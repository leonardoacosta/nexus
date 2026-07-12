# Plan 030: Env-doc residue — document ELEVENLABS_VOICE_ID + VM_URL in .env.example, fix the false "systemd unit sets this" comment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED you MUST
> append `spec-impact: <slug>[, ...]` or `spec-impact: none` to the row
> (expected here: `spec-impact: none` — this plan documents the
> `elevenlabs-credential` spec's mandated fallback, it does not change it).
>
> **Drift check (run first)**:
> `git diff --stat b7096486..HEAD -- .env.example apps/agent/src/routes/wave-plans.ts deploy/nexus-agent.service apps/agent/src/notifications/router.ts`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (At planning time HEAD had already
> advanced to `d458ef8e` — that commit touched only `.beads/issues.jsonl`,
> zero drift in the in-scope files. Leo works directly in this checkout;
> expect main to advance again mid-execution.)

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `b7096486`, 2026-07-11

## Why this matters

Plan 022 (DONE, 2026-07-05) reconciled operator-facing env vars into the two
example files and established `.env.example` as the surface the nightly H1
audit checks (`Env var X used in source but missing from .env.example`).
Three residues have since accumulated, and each one makes the H1 audit — or an
operator reading the code — lie:

1. `ELEVENLABS_VOICE_ID` was deleted from `.env.example` by plan 022 (verified
   zero readers at 09:23 on 2026-07-05), then a *reader was reintroduced in
   source 17 minutes later* (commit `8e1cee02`, 09:40) because the OpenSpec
   `elevenlabs-credential` spec mandates it as a backward-compat fallback. The
   var is now read, spec-mandated, test-pinned — and undocumented in the file
   that claims to document every env read. **Settled resolution (do not
   re-litigate)**: resolve by DOCUMENTING — re-add the var to `.env.example`
   with a deprecation note; do NOT remove the code fallback (spec-mandated) and
   do NOT touch `router.ts`/its test. (The audit seam had suggested removing
   the code read instead; that suggestion is overridden by this settled call.)
2. `VM_URL` (read by `apps/agent/src/telemetry/vm-read.ts:76`, correctly
   documented in its canonical home `deploy/secrets.env.example:19`) is missing
   from the "Secrets-File Variables" cross-reference block that plan 022's
   maintenance note prescribed extending for exactly this case — so H1
   permanently flags a var that is in fact correctly documented.
3. A docstring in `apps/agent/src/routes/wave-plans.ts:110` claims the systemd
   unit sets `NEXUS_REPO_ROOT`. It does not — `deploy/nexus-agent.service` sets
   only `LOG_LEVEL`, `PATH`, and `EnvironmentFile=-%h/.env`. An operator
   debugging repo-root resolution against the unit file finds nothing.

After this plan the live H1 count drops 15 → 13 (the accepted steady state:
plan 022's 11 deliberately-deferred knobs + the ambient `COLUMNS`/`TMUX_PANE`
class), and both false doc claims are gone. All three fixes are verified
findings from the Wave-3 `/improve:code` audit (evidence:
`/tmp/nx-code-audit/plan-030.json`, findings DED-1, DED-2, DED-4 — all
CONFIRMED by adversarial verification).

## Current state

All excerpts below are fresh reads at commit `b7096486`.

### File roles

- `.env.example` — dev/test env documentation, the surface H1 audits.
  Lines 94–100 hold the ElevenLabs block; lines 161–169 hold the
  "Secrets-File Variables" cross-reference block (established by plan 022).
- `deploy/secrets.env.example` — production operator env (canonical home for
  secrets-file vars; `VM_URL` lives at line 19). NOT modified by this plan.
- `apps/agent/src/routes/wave-plans.ts` — wave-plan routes; `resolveRepoRoot()`
  docstring at lines 108–115 contains the false systemd claim.
- `deploy/nexus-agent.service` — the systemd unit; its complete env surface is
  lines 52, 62, 66. NOT modified by this plan (Option B below is rejected).
- `apps/agent/src/notifications/router.ts` — TTS channel; reads
  `ELEVENLABS_VOICE_ID` at line 109 (spec-mandated fallback). READ-ONLY
  context for this plan — do not edit.
- `openspec/specs/elevenlabs-credential/spec.md` — line 25 mandates the env
  fallback. READ-ONLY.

### `.env.example:94-100` — ElevenLabs block (ELEVENLABS_VOICE_ID absent)

```
# Optional: ElevenLabs API key for text-to-speech notifications.
ELEVENLABS_API_KEY=

# Optional: ElevenLabs default voice ID for TTS notifications. Resolution
# order: per-project override row -> this var -> unset (signal-only; the Mac
# listener synthesizes locally). Read by apps/agent/src/notifications/router.ts.
ELEVENLABS_DEFAULT_VOICE_ID=
```

### `.env.example:161-169` — Secrets-File Variables block (VM_URL absent)

```
# ── Secrets-File Variables ───────────────────────────────────────────
#
# The following are read from the environment but their canonical home is
# deploy/secrets.env.example (copied to ~/.config/nexus/secrets.env per
# machine) — do NOT put them in .env. Named here so the env-var audit (H1)
# maps every source read to a documented location:
#
# NEXUS_ATTACH_SECRET, APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_PATH,
# APNS_BUNDLE_ID, APNS_HOST, HEALTH_PUSH_TOKEN_PATH, CC_CREDENTIALS_PATH
```

Plan 022's maintenance note (`plans/022-env-example-drift-reconciliation.md`,
"Future interaction" bullet) prescribes: *"The 'Secrets-File Variables' comment
block in `.env.example` is the sanctioned way to satisfy H1 for vars whose
canonical home is `deploy/secrets.env.example` — extend that block rather than
duplicating secret entries."* `VM_URL` landed in `deploy/secrets.env.example`
(commit `a8646685`) after plan 022's last edit and never got its block entry.

### `apps/agent/src/routes/wave-plans.ts:108-118` — the false comment

```ts
/**
 * Resolve the repository root that owns `docs/apply/`. Priority:
 *   1. `NEXUS_REPO_ROOT` env var (canonical override — systemd unit sets this).
 *   2. Walk up from `process.cwd()` looking for `docs/apply/`.
 *   3. Fall back to `<homedir>/dev/nx`.
 *
 * Exported for tests so fixtures can pin the root.
 */
export function resolveRepoRoot(): string {
  const envRoot = process.env.NEXUS_REPO_ROOT;
```

### `deploy/nexus-agent.service:52,62,66` — the unit's complete env surface

```
Environment=LOG_LEVEL=info
Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.env
```

No `Environment=NEXUS_REPO_ROOT=...` line exists. The only way the unit could
carry the var is indirectly via `EnvironmentFile=-%h/.env`, and it is absent
from `~/.env` on the deployment machine — the cwd-walk fallback
(wave-plans.ts:121-127) plus the `<homedir>/dev/nx` fallback carry production.

**Design decision surfaced (per the audit brief), Option A chosen:**

- **Option A (RECOMMENDED, what this plan does)**: fix the comment to describe
  reality — the var is an override an operator *may* set via `~/.env` (picked
  up through `EnvironmentFile=-%h/.env`) or the process environment; the unit
  itself does not set it.
- **Option B (REJECTED — do not do)**: add
  `Environment=NEXUS_REPO_ROOT=%h/dev/personal/nexus` to
  `deploy/nexus-agent.service`. Rejected because (a) it hardcodes a
  per-machine path into a fleet-shared unit file, (b) plan 022 classified
  `NEXUS_REPO_ROOT` as a deliberately-undocumented dev knob whose ownership
  call is deferred, and (c) the fallback chain already carries production —
  a comment fix is truth-restoring; a unit edit is new behavior nobody asked
  for.

### `apps/agent/src/notifications/router.ts:107-111,146` — the spec-mandated reader (READ-ONLY context)

```ts
  const envKey = process.env.ELEVENLABS_API_KEY;
  if (envKey && envKey.length > 0) {
    return { apiKey: envKey, voiceId: process.env.ELEVENLABS_VOICE_ID ?? null };
  }
  return null;
```

```ts
  return credentialVoiceId ?? defaultVoiceId();   // :146 — env voiceId wins over ELEVENLABS_DEFAULT_VOICE_ID
```

`defaultVoiceId()` (router.ts:54-55) reads `ELEVENLABS_DEFAULT_VOICE_ID`.
Precedence fact for the doc comment you will write: `ELEVENLABS_VOICE_ID` is
only read on the env-key fallback path (no DB credential row, or decrypt
failure); on that path it becomes `credentialVoiceId` and therefore takes
precedence over `ELEVENLABS_DEFAULT_VOICE_ID` at :146.

The spec mandate (`openspec/specs/elevenlabs-credential/spec.md:25`):

> When the row exists, the decrypted `api_key` and `voice_id` take precedence
> over `process.env.ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`. When the row
> is absent, the env vars MUST be used (backwards compatibility).

The fallback is pinned by
`apps/agent/src/notifications/tts-credential-resolve.test.ts` ("falls back to
the env var when no DB row exists", which sets
`process.env.ELEVENLABS_VOICE_ID = "voice-env"` at line 86). Neither file may
be edited by this plan.

### Live H1 baseline (runtime evidence at planning time)

`~/.claude/scripts/bin/audit-scan --project . --json` at `b7096486` emits
**15** H1 findings, including
`Env var ELEVENLABS_VOICE_ID used in source but missing from .env.example` and
`Env var VM_URL used in source but missing from .env.example`. The other 13
are the settled residue: plan 022's 11 deferred knobs (`NEXUS_PHONE_PEER`,
`NEXUS_PRESENCE_USER`, `NEXUS_TAILSCALE_POLL_MS`, `NEXUS_USAGE_POLL_INTERVAL_MS`,
`NX_BUNDLE_DERIVED_DATA`, `NEXUS_REPO_ROOT`, `NEXUS_SKIP_SCHEMA_CHECK`,
`NEXUS_HEAVY_TESTS`, `NEXUS_PG_TESTS`, `NEXUS_RUN_LIVE_REAPER_TESTS`, `USER`)
plus ambient `COLUMNS`/`TMUX_PANE`. Do NOT document any of those 13 — plan
022 deliberately deferred them; expected post-plan count is exactly **13**.

### Repo facts (this repo is NOT standard T3)

- pnpm + Bun monorepo, no tRPC. Quality gates: `pnpm typecheck`, `pnpm lint`,
  `bun test` (root run discovers all `*.test.ts`), `scripts/lint-sql-safety.sh`.
- CI (`.github/workflows/ci.yml`) is RED on main since 2026-07-10 solely due
  to a lint-sql-safety false positive that plan 023 fixes. Until 023 lands,
  the bar for this plan is "no new failures attributable to changed files",
  not "CI green".
- Known pre-existing baseline failure at planning time:
  `pnpm --filter @nexus/agent typecheck` exits 2 with
  `src/routes/credentials.test.ts(20,3)/(26,3): error TS2300: Duplicate identifier 'initCredentialRoutes'`
  — unrelated to every in-scope file (concurrent session work). Capture your
  own baseline in Step 1 and compare after.

## Commands you will need

| Purpose | Command (run from repo root) | Expected on success |
|---------|------------------------------|---------------------|
| Drift check | `git diff --stat b7096486..HEAD -- .env.example apps/agent/src/routes/wave-plans.ts deploy/nexus-agent.service apps/agent/src/notifications/router.ts` | empty output (or see STOP) |
| H1 count | `~/.claude/scripts/bin/audit-scan --project . --json \| python3 -c "import json,sys; d=json.load(sys.stdin); h1=[x['message'] for x in d['findings'] if x['id']=='H1']; print(len(h1)); [print(m) for m in sorted(h1)]"` | before: 15; after: 13, list contains neither ELEVENLABS_VOICE_ID nor VM_URL |
| Guard tests | `bun test apps/agent/src/routes/wave-plans.test.ts apps/agent/src/notifications/tts-credential-resolve.test.ts` | `17 pass / 0 fail` (baseline-verified at planning time) |
| Typecheck (agent) | `pnpm --filter @nexus/agent typecheck` | same error set as your Step-1 baseline — no NEW errors (baseline exits 2 on pre-existing credentials.test.ts TS2300) |

## Scope

**In scope** (the only files you may modify):

- `.env.example` — two comment/entry additions (Steps 2 and 3)
- `apps/agent/src/routes/wave-plans.ts` — ONE docstring line, comment-only
  (Step 4)
- `plans/README.md` — your status row on completion

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/notifications/router.ts` — the `ELEVENLABS_VOICE_ID` read is
  spec-mandated backward compat (`openspec/specs/elevenlabs-credential/spec.md:25`).
  Removing or renaming it is settled OFF the table.
- `apps/agent/src/notifications/tts-credential-resolve.test.ts` — pins the
  spec-mandated fallback; stays as-is.
- `deploy/nexus-agent.service` — Option B rejected (see Current state).
- `deploy/secrets.env.example` — `VM_URL` is already correctly documented
  there (line 19); this plan only adds the cross-reference mention.
- `deploy/README.md:117` — documents `ELEVENLABS_VOICE_ID` for operators;
  already consistent with keeping the var documented. No edit needed.
- `apps/agent/src/database.ts` (the db:push error-message finding) — belongs
  to another Wave-3 plan; not yours.
- Any of the 13 residual H1 vars (`NEXUS_REPO_ROOT` included) — plan 022
  deliberately deferred documenting them. Fixing the wave-plans.ts *comment*
  is in scope; adding `NEXUS_REPO_ROOT` to `.env.example` is NOT.
- `openspec/specs/**` — read-only context.

## Git workflow

- This plan executes in a worktree (Leo works directly in
  `~/dev/personal/nexus`; expect main to advance mid-execution).
- Branch: `advisor/030-env-doc-residue` (matches Wave-1/2 convention, e.g.
  `advisor/022-...`).
- Single commit, conventional style, message written via a file and
  `git commit -F` (never a HEREDOC chained with `&&`). Example subject:
  `docs(env): document ELEVENLABS_VOICE_ID + VM_URL residue, fix NEXUS_REPO_ROOT comment (plan 030)`
- Stage ONLY the three in-scope files by explicit path. Never `git add .`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Capture baselines

From the repo root, run the drift check, the H1 count, the guard tests, and
the agent typecheck (all from "Commands you will need"). Save the typecheck
error list and the H1 list.

**Verify**: drift check → empty; H1 count → `15` with both
`ELEVENLABS_VOICE_ID` and `VM_URL` lines present; guard tests → `17 pass 0 fail`;
typecheck → exits 2 with only the two `credentials.test.ts` TS2300 errors (if
the typecheck baseline shows errors in any IN-SCOPE file, STOP).

### Step 2: Re-add `ELEVENLABS_VOICE_ID` to `.env.example` with a deprecation note

Edit `.env.example`. Directly after the `ELEVENLABS_DEFAULT_VOICE_ID=` line
(line 100 in the excerpt above), insert a blank line and then:

```
# DEPRECATED — legacy voice-id fallback, kept for backward compatibility only
# (openspec/specs/elevenlabs-credential/spec.md:25 mandates the env fallback
# when no elevenlabs_credentials DB row exists). Read by
# apps/agent/src/notifications/router.ts on the ELEVENLABS_API_KEY env-fallback
# path; when set there it takes precedence over ELEVENLABS_DEFAULT_VOICE_ID.
# Prefer the credential store (PATCH /elevenlabs/credentials) or
# ELEVENLABS_DEFAULT_VOICE_ID above. Do not set both voice vars.
ELEVENLABS_VOICE_ID=
```

Do not modify the existing `ELEVENLABS_API_KEY` / `ELEVENLABS_DEFAULT_VOICE_ID`
entries or their comments.

**Verify**: `grep -n "^ELEVENLABS_VOICE_ID=" .env.example` → exactly one match,
line number greater than the `ELEVENLABS_DEFAULT_VOICE_ID=` line.

### Step 3: Append `VM_URL` to the Secrets-File Variables block

Edit `.env.example`. In the Secrets-File Variables block, change the final
list line

```
# APNS_BUNDLE_ID, APNS_HOST, HEALTH_PUSH_TOKEN_PATH, CC_CREDENTIALS_PATH
```

to

```
# APNS_BUNDLE_ID, APNS_HOST, HEALTH_PUSH_TOKEN_PATH, CC_CREDENTIALS_PATH,
# VM_URL
```

(Comment mention is the sanctioned H1 satisfaction for secrets-homed vars —
plan 022 maintenance note. Do NOT add a `VM_URL=` assignment line and do NOT
copy the production URL from `deploy/secrets.env.example` into this file.)

**Verify**: `grep -n "VM_URL" .env.example` → exactly one match, inside the
Secrets-File Variables comment block (a `# VM_URL` comment line, no `=`).

### Step 4: Fix the `resolveRepoRoot` docstring in `wave-plans.ts`

Edit `apps/agent/src/routes/wave-plans.ts`. Replace the single line (line 110
at planning time):

```
 *   1. `NEXUS_REPO_ROOT` env var (canonical override — systemd unit sets this).
```

with:

```
 *   1. `NEXUS_REPO_ROOT` env var (canonical override — set via `~/.env`,
 *      loaded through the unit's `EnvironmentFile=-%h/.env`, or the process
 *      environment; deploy/nexus-agent.service does NOT set it).
```

Comment-only change: no code line in the function body may change.

**Verify**:
`grep -rn "systemd unit sets this" apps/agent/src/` → no matches; and
`git diff apps/agent/src/routes/wave-plans.ts | grep -E "^[+-]" | grep -v "^[+-][+-]" | grep -vE "^\+\s*\*|^-\s*\*"` → empty (every changed line is a `*` comment line).

### Step 5: Run the full verification battery

Run all four commands from "Commands you will need".

**Verify**:
- H1 count → `13`; the sorted list contains NEITHER
  `Env var ELEVENLABS_VOICE_ID ...` NOR `Env var VM_URL ...`; every remaining
  line names one of the 13 settled vars listed in Current state.
- Guard tests → `17 pass / 0 fail`.
- Agent typecheck → error set identical to your Step-1 baseline (no new
  errors; the pre-existing credentials.test.ts TS2300 pair may still be there).
- `git status --short` → only the three in-scope files modified.

### Step 6: Commit and update the plan index

Write the commit message to a temp file, `git commit -F` it with the three
files staged by explicit path, then update this plan's row in
`plans/README.md` to DONE with a one-line evidence summary (H1 15→13, tests
17/0) and `spec-impact: none`.

**Verify**: `git show --stat HEAD` → exactly 3 files changed (or 4 including
`plans/README.md` if committed together); `git log -1 --format=%s` → the
conventional subject line.

## Test plan

No new tests: all three changes are comments/doc entries (the only `.ts` edit
is inside a `/** ... */` block). The regression guards are the two EXISTING
suites, baseline-verified green at planning time:

- `apps/agent/src/notifications/tts-credential-resolve.test.ts` — pins the
  spec-mandated `ELEVENLABS_VOICE_ID` fallback this plan documents (and must
  not change).
- `apps/agent/src/routes/wave-plans.test.ts` — pins `resolveRepoRoot()`
  behavior around the edited docstring.

Verification: `bun test apps/agent/src/routes/wave-plans.test.ts apps/agent/src/notifications/tts-credential-resolve.test.ts` → `17 pass / 0 fail`.
The H1 re-run (audit-scan) is the runtime evidence that the documentation
change achieved its purpose — paste its post-fix output in your completion
report.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "^ELEVENLABS_VOICE_ID=" .env.example` → `1`
- [ ] `grep -c "VM_URL" .env.example` → `1` (comment mention in the
      Secrets-File Variables block, no assignment)
- [ ] `grep -rn "systemd unit sets this" apps/agent/src/` → no matches
- [ ] H1 count command → `13`, with no `ELEVENLABS_VOICE_ID` or `VM_URL` rows
- [ ] `bun test apps/agent/src/routes/wave-plans.test.ts apps/agent/src/notifications/tts-credential-resolve.test.ts` → 17 pass, 0 fail
- [ ] `pnpm --filter @nexus/agent typecheck` → no errors beyond the Step-1
      baseline set
- [ ] `git status --short` shows no modified files outside the in-scope list
- [ ] `plans/README.md` row for 030 updated, with `spec-impact: none` appended

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope file changed since `b7096486` AND the
  "Current state" excerpts no longer match the live code (main advances
  constantly here — a diff alone is not a STOP, a excerpt mismatch is).
- Your Read/Edit tooling is permission-denied on `.env.example`. Plan 022 hit
  `.env*` deny rules twice; both were fixed, but if a gate re-appears, report
  the denial — do NOT bypass via shell redirection (`echo >>`).
- The Step-1 H1 baseline is not 15, or is missing either the
  `ELEVENLABS_VOICE_ID` or `VM_URL` row (someone else already fixed part of
  this — report the overlap, do not double-apply).
- The Step-5 H1 count is anything other than 13 after one re-check of your
  edits (a NEW undocumented var landed mid-execution; it is not yours to fix).
- `~/.claude/scripts/bin/audit-scan` does not exist or errors on this machine.
- The Step-1 typecheck baseline shows errors in `wave-plans.ts` or any other
  in-scope file (drift), or Step 5 shows any typecheck error not in your
  baseline.
- Fixing anything appears to require editing `router.ts`, its test, the
  OpenSpec spec, `deploy/nexus-agent.service`, or any other out-of-scope file.
- Anyone or anything suggests removing the `ELEVENLABS_VOICE_ID` code fallback
  "since it's deprecated" — that is spec-mandated; the deprecation note is
  documentation, not a removal license.

## Maintenance notes

- **Reviewer focus**: confirm the diff is comments/doc-entries only (the sole
  `.ts` hunk must be entirely `*`-prefixed docstring lines); confirm no real
  secret value entered `.env.example` (both new entries are empty/comment);
  confirm none of the 13 settled H1 vars got documented as a drive-by.
- **H1 steady state is now 13** (was 11 after plan 022 + the two ambient
  `COLUMNS`/`TMUX_PANE` rows the current scanner also counts). Record: any
  future H1 count above 13 is NEW drift, not settled residue — that number is
  what lets the nightly audit distinguish the two without re-adjudicating
  plan 022's deferred list each cycle.
- **ELEVENLABS_VOICE_ID's long-term fate** belongs to the
  `elevenlabs-credential` spec, not to env-doc hygiene: if a future proposal
  drops the spec's backward-compat clause (spec.md:25), that change owns
  removing the router.ts read, its test pin (tts-credential-resolve.test.ts),
  this `.env.example` entry, and `deploy/README.md:117` together.
- **NEXUS_REPO_ROOT documentation** remains deliberately deferred (plan 022's
  ops-docs-vs-operator-examples call). This plan only made the code comment
  truthful; the ownership decision is still open.
- **Deliberately not folded in**: the `database.ts` db:push error-message fix
  and the lint-sql-safety re-green (other Wave-3 plans own those); Option B
  (unit-file `Environment=` line) — rejected, see Current state.
