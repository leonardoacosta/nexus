# Plan 022: Reconcile operator-facing env vars into the correct example file; fix APNS bundle naming drift

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git -C /home/nyaptor/dev/nx diff --stat c67ff12c..HEAD -- .env.example deploy/secrets.env.example apps/agent/src/health-push/ apps/agent/src/db/retention.ts apps/agent/src/cc-credential-manager.ts apps/agent/src/notifications/router.ts apps/web/src/lib/agent-config.ts`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (docs-only; zero source edits; zero runtime effect — every var involved has a code-level default)
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `c67ff12c`, 2026-07-05

## Why this matters

Eleven operator-facing environment variables are read by live code but documented in neither `.env.example` nor `deploy/secrets.env.example`, so an operator provisioning a new machine has no way to discover them short of grepping source. Worse, the canonical secrets example documents two APNS variable names (`APNS_BUNDLE_IOS`, `APNS_BUNDLE_WATCH`) that **no code reads** — the source reads `APNS_BUNDLE_ID` and `APNS_HOST` — so an operator setting those documented names would silently change nothing. This plan makes the two example files match reality: every documented var name greps to a real `process.env` read, and every operator-facing read is documented in exactly one canonical place. The repo's own audit tool (`audit-scan` check H1) currently reports 26 findings for this; this plan drops it to 11 (the remainder is a settled do-not-document list — see Scope).

This is a **docs-only plan. You must not edit any `.ts`/`.tsx`/`.sh`/`.plist` file.**

## Current state

All excerpts below are from commit `c67ff12c` (verified by the plan author on 2026-07-05).

### The two files you will edit

- `.env.example` (repo root, 135 lines) — operator-facing agent config; non-secret vars with defaults live here as `NAME=` entries or commented defaults. It ends with a `# ── System-Provided Variables ──` comment block (lines 128–135) that documents `HOME` **as a comment only**, "to satisfy the env-var audit rule (H1)". That comment-mention pattern is load-bearing: audit-scan H1 clears a var when its name appears **anywhere** in `.env.example`, including comments (H1 uses `grep -q "$var" .env.example`).
- `deploy/secrets.env.example` (36 lines) — per-CLAUDE.md the **canonical** secrets file; copied to `~/.config/nexus/secrets.env` on each machine. Secrets + machine-specific paths live here.

Classification rule (from the repo convention): **secrets + machine-specific paths → `deploy/secrets.env.example`; non-secret app config with code defaults → `.env.example` (commented default)**.

### The APNS naming drift

`deploy/secrets.env.example:20-28` today:

```
# ── Apple Push Notification service ──────────────────────────────────
# Reuses APNs Auth Key (Apple's 2-key-per-team limit hit; do NOT create a
# new key — Z3BX2Y72Q7 is canonical). Wired into apps/agent push-delivery
# pipeline (see bd:nx-5eqal). Provisioning workflow in apps/swift/fastlane/.
APNS_KEY_ID=Z3BX2Y72Q7
APNS_TEAM_ID=DX3Y367L2A
APNS_KEY_PATH=/Users/leonardoacosta/.appstoreconnect/private_keys/AuthKey_Z3BX2Y72Q7.p8
APNS_BUNDLE_IOS=dev.leonardoacosta.nexus.ios
APNS_BUNDLE_WATCH=dev.leonardoacosta.nexus.watch
```

What source actually reads — `apps/agent/src/health-push/apns-sender.ts:31-41`:

```ts
export function resolveApnsConfig(): ApnsConfig {
  const keyId = process.env.APNS_KEY_ID ?? "Z3BX2Y72Q7";
  return {
    keyId,
    teamId: process.env.APNS_TEAM_ID ?? "DX3Y367L2A",
    bundleId: process.env.APNS_BUNDLE_ID ?? "dev.leonardoacosta.nexus.ios",
    // dev-signed app => sandbox APNs. Override with APNS_HOST for a prod build.
    host: process.env.APNS_HOST ?? "https://api.sandbox.push.apple.com",
    keyPath:
      process.env.APNS_KEY_PATH ??
      join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`),
  };
}
```

Verified facts (plan author's whole-repo grep at `c67ff12c`):

- `APNS_BUNDLE_IOS` / `APNS_BUNDLE_WATCH` appear **only** in `deploy/secrets.env.example:27-28`. No `.ts`, `.sh`, `.plist`, launchd agent, `deploy/install.sh`, or `deploy/launchagents/*` reads or re-exports them. There is no rename/transform layer.
- `deploy/nexus-agent.service:56` says only: `# Load from ~/.env for machine-local secrets (ELEVENLABS_API_KEY, APNS_*, etc.)` — a comment, no name mapping.
- The APNs sender exists solely to wake the **iOS** app for a HealthKit flush (file header of `apns-sender.ts`); there is no watch push path, so no code should read a watch bundle var. This is example-file rot, **not** a source bug. Resolution: reconcile the example to match source. Do NOT touch source.

### A second instance of the same drift class (in `.env.example`)

`.env.example:83-84`:

```
# Optional: ElevenLabs voice ID (default: 21m00Tcm4TlvDq8ikWAM — Rachel)
ELEVENLABS_VOICE_ID=
```

No code anywhere reads `ELEVENLABS_VOICE_ID` (whole-repo grep, zero hits outside this file). The real read is `apps/agent/src/notifications/router.ts:54`:

```ts
function defaultVoiceId(): string | null {
  const v = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  return v && v.length > 0 ? v : null;
}
```

The documented "default: 21m00Tcm4TlvDq8ikWAM — Rachel" is also wrong: when unset, resolution falls through per-project override → env var → `null` (signal-only degradation; the Mac listener synthesizes locally). There is no hardcoded voice default.

### The 11 missing operator-facing vars, with their verified read sites and code defaults

| Var | Read site (verified at c67ff12c) | Code default | Home |
| --- | --- | --- | --- |
| `APNS_BUNDLE_ID` | `apps/agent/src/health-push/apns-sender.ts:35` | `dev.leonardoacosta.nexus.ios` | secrets example (APNS block) |
| `APNS_HOST` | `apps/agent/src/health-push/apns-sender.ts:37` | `https://api.sandbox.push.apple.com` | secrets example (APNS block) |
| `HEALTH_PUSH_TOKEN_PATH` | `apps/agent/src/health-push/device-token-store.ts:25` | `~/.config/nexus/apns-device-tokens.json` | secrets example (machine path) |
| `CC_CREDENTIALS_PATH` | `apps/agent/src/cc-credential-manager.ts:128` | `~/.claude/.credentials.json` (`DEFAULT_CREDENTIALS_PATH`, line 49) | secrets example (machine path) |
| `HEALTH_PUSH_INTERVAL_MS` | `apps/agent/src/health-push/health-push-scheduler.ts:20` | `1800000` (30 min, `DEFAULT_INTERVAL_MS` line 12) | `.env.example` |
| `MX_GATEWAY_URL` | `apps/agent/src/routes/sources.ts:19`, `triage.ts:23`, `thread.ts:22` | `http://127.0.0.1:8799` | `.env.example` |
| `ELEVENLABS_DEFAULT_VOICE_ID` | `apps/agent/src/notifications/router.ts:54` | none (null → signal-only fallback) | `.env.example` (replaces stale `ELEVENLABS_VOICE_ID`) |
| `CRON_RUNS_RETENTION_DAYS` | `apps/agent/src/db/retention.ts:21` | `90` | `.env.example` |
| `BLOAT_RADAR_RETENTION_DAYS` | `apps/agent/src/db/retention.ts:24` | `90` | `.env.example` |
| `SPEC_SESSIONS_RETENTION_DAYS` | `apps/agent/src/db/retention.ts:31` | `365` | `.env.example` |
| `NEXT_PUBLIC_NEXUS_AGENT_URL` | `apps/web/src/lib/agent-config.ts:17` | none (unset → app renders "configure agent URL" message) | `.env.example` (web section) |

Context for the machine-path vars (inline into your comments):

- `device-token-store.ts:22-27` — comment says `~/.config/nexus` is in the agent service's `ReadWritePaths` sandbox allowlist (`~/.nexus` is NOT — EROFS under the hardened unit).
- `agent-config.ts:4-12` — `NEXT_PUBLIC_NEXUS_AGENT_URL` is the single agent the web app attaches to, e.g. `http://100.73.182.4:7400` over the tailnet; `NEXT_PUBLIC_*` so it is inlined at build time.

### How the H1 gate works (verified against the audit-scan source)

`~/.claude/scripts/bin/audit-scan` check H1 (script lines 852-876): collects every `process.env.<UPPER_NAME>` in source, then flags each name for which `grep -q "$var" .env.example` fails. Consequences you must exploit:

1. Only the **root `.env.example`** is consulted — vars homed in `deploy/secrets.env.example` still flag unless their **name is also mentioned in `.env.example`** (comment mention suffices — that is exactly what the existing `HOME` block at `.env.example:128-135` does).
2. Baseline at `c67ff12c`: **26 H1 findings**. The 15 that this plan clears: the 11 table vars above + `APNS_KEY_ID`, `APNS_KEY_PATH`, `APNS_TEAM_ID`, `NEXUS_ATTACH_SECRET` (already documented in the secrets example; they clear via the same cross-reference comment block). The **11 that must remain** (settled do-not-document list — adding any of them is a scope violation): `NEXUS_HEAVY_TESTS`, `NEXUS_PG_TESTS`, `NEXUS_RUN_LIVE_REAPER_TESTS`, `USER`, `NX_BUNDLE_DERIVED_DATA`, `NEXUS_REPO_ROOT`, `NEXUS_SKIP_SCHEMA_CHECK`, `NEXUS_PHONE_PEER`, `NEXUS_PRESENCE_USER`, `NEXUS_TAILSCALE_POLL_MS`, `NEXUS_USAGE_POLL_INTERVAL_MS`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| H1 count | `~/.claude/scripts/bin/audit-scan --project /home/nyaptor/dev/nx --json --category documentation 2>/dev/null \| jq '[.findings[] \| select(.id=="H1")] \| length'` | `26` before, `11` after (verified working at plan time) |
| H1 names | same, but `jq -r '.findings[] \| select(.id=="H1") \| .message'` | list of `Env var X used in source but missing from .env.example` |
| Reverse doc-rot guard | see Step 4 loop | every added name has a source read |
| Scope guard | `git -C /home/nyaptor/dev/nx status --porcelain` | only `.env.example`, `deploy/secrets.env.example` (and `plans/README.md` if you update the index) modified |

No `bun test` / `pnpm typecheck` run is required: this plan changes zero source files, and `.env.example` files are not compiled, linted, or imported. The scope guard + H1 gate are the whole verification surface. There is no DB involvement — nothing here touches `packages/db`, so no migration question arises.

## Scope

**In scope** (the only files you may modify):

- `.env.example`
- `deploy/secrets.env.example`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/health-push/apns-sender.ts` — the naming drift is resolved by fixing the *example*, not the source. Any source edit is a STOP condition.
- Any other `process.env` read site in source — plan 022 is docs-only by charter.
- `deploy/install.sh`, `deploy/nexus-agent.service`, `deploy/launchagents/*` — no env plumbing changes.
- `apps/web/` — do NOT create an `apps/web/.env.example`; `NEXT_PUBLIC_NEXUS_AGENT_URL` is documented in the root `.env.example` (that is the file H1 audits).
- Test-only flags (`NEXUS_HEAVY_TESTS`, `NEXUS_PG_TESTS`, `NEXUS_RUN_LIVE_REAPER_TESTS`), ambient `USER`, and the dev/tuning knobs (`NX_BUNDLE_DERIVED_DATA`, `NEXUS_REPO_ROOT`, `NEXUS_SKIP_SCHEMA_CHECK`, `NEXUS_PHONE_PEER`, `NEXUS_PRESENCE_USER`, `NEXUS_TAILSCALE_POLL_MS`, `NEXUS_USAGE_POLL_INTERVAL_MS`) — settled exclusions. Do NOT add them to either example file, even though they appear in H1 output.
- Never put a real secret value in either file. The examples carry placeholders and non-secret defaults only (the existing `APNS_KEY_ID`/`APNS_TEAM_ID` identifiers and the ElevenLabs `sk_<redacted>` placeholder are the established bar — match it).

## Git workflow

- Work on the **current branch** (repo convention for these plans; do not create a branch unless your dispatcher says otherwise).
- Single commit, targeted adds only (never `git add .`):
  `git add .env.example deploy/secrets.env.example plans/README.md .beads/ && git commit -m "docs(env): reconcile operator-facing env vars, fix APNS bundle naming drift (plan 022)" && git push`
  (Include `.beads/` only if the pre-commit hook flushed changes there; message style matches repo log, e.g. `docs(plans): ...`, `feat(statusline): ...`.)
- Work is not complete until `git push` succeeds.

## Steps

### Step 1: Baseline the H1 count

Run the H1-count command from the table above.

**Verify**: output is `26`. If it is any other number, the codebase drifted since `c67ff12c` — diff the H1 name list against the 26 names in "Current state" reasoning: if the delta is *only* new vars outside this plan's 15, proceed (your end-state target is `baseline - 15`); if any of the 15 names is already absent, STOP (someone partially did this work).

### Step 2: Fix `deploy/secrets.env.example` — APNS block + machine paths

Replace lines 27–28 (`APNS_BUNDLE_IOS=...` and `APNS_BUNDLE_WATCH=...`) with commented, source-true entries, and append a machine-paths section before the OpenTelemetry block. Target shape for the APNS block tail (keep lines 20–26 exactly as they are):

```
# The agent's health-push sender (apps/agent/src/health-push/apns-sender.ts)
# reads APNS_BUNDLE_ID and APNS_HOST. The former APNS_BUNDLE_IOS /
# APNS_BUNDLE_WATCH names were never read by any code (reconciled 2026-07-05,
# plan 022); the watch bundle (dev.leonardoacosta.nexus.watch) has no env knob.
# Defaults below match the code — uncomment only to override.
# APNS_BUNDLE_ID=dev.leonardoacosta.nexus.ios
# Sandbox host is correct for dev-signed builds; use https://api.push.apple.com
# for App Store / TestFlight builds.
# APNS_HOST=https://api.sandbox.push.apple.com
```

New section (insert between the APNS block and the OpenTelemetry block):

```
# ── Machine-specific path overrides (defaults are sane; usually leave unset) ─
# APNs device-token store. Default: ~/.config/nexus/apns-device-tokens.json.
# ~/.config/nexus is in the systemd unit's ReadWritePaths allowlist (~/.nexus
# is NOT — writes there fail EROFS under the hardened unit).
# Read by apps/agent/src/health-push/device-token-store.ts.
# HEALTH_PUSH_TOKEN_PATH=
# Claude Code credentials file the agent's credential manager watches.
# Default: ~/.claude/.credentials.json.
# Read by apps/agent/src/cc-credential-manager.ts.
# CC_CREDENTIALS_PATH=
```

**Verify**:
`grep -c "APNS_BUNDLE_IOS\|APNS_BUNDLE_WATCH" /home/nyaptor/dev/nx/deploy/secrets.env.example` → `0` (the old names may survive only inside the explanatory comment — if you kept them in the comment as shown above, expected count is `2` and both hits are `#` comment lines; either is acceptable, but no *assignment* lines may remain: `grep -c "^APNS_BUNDLE_IOS=\|^APNS_BUNDLE_WATCH=" deploy/secrets.env.example` → `0`).
`grep -c "APNS_BUNDLE_ID\|APNS_HOST\|HEALTH_PUSH_TOKEN_PATH\|CC_CREDENTIALS_PATH" /home/nyaptor/dev/nx/deploy/secrets.env.example` → `>= 4`.

### Step 3: Fix `.env.example` — rename stale var, add missing vars, add secrets cross-reference block

Four edits. Note: some harnesses have a permission deny-rule on `.env*` paths — if your Read/Edit tool is denied on `.env.example`, that is a STOP condition (report it; do not shell around the permission system).

**3a — ElevenLabs rename** (lines 83–84). Replace:

```
# Optional: ElevenLabs voice ID (default: 21m00Tcm4TlvDq8ikWAM — Rachel)
ELEVENLABS_VOICE_ID=
```

with:

```
# Optional: ElevenLabs default voice ID for TTS notifications. Resolution
# order: per-project override row -> this var -> unset (signal-only; the Mac
# listener synthesizes locally). Read by apps/agent/src/notifications/router.ts.
ELEVENLABS_DEFAULT_VOICE_ID=
```

**3b — retention knobs** (immediately after `HEALTH_RETENTION_DAYS=30`, line 41):

```
# Optional: Retention windows for cron-run / bloat-radar / spec-session telemetry
# (days). Read by apps/agent/src/db/retention.ts.
CRON_RUNS_RETENTION_DAYS=90
BLOAT_RADAR_RETENTION_DAYS=90
SPEC_SESSIONS_RETENTION_DAYS=365
```

**3c — agent config additions** (in the `# ── Agent Configuration ──` section, near `NEXUS_SOCKET=`):

```
# Optional: Interval between APNs health-push wakeups in ms (default: 1800000 = 30 min).
# Read by apps/agent/src/health-push/health-push-scheduler.ts.
HEALTH_PUSH_INTERVAL_MS=

# Optional: MX sidecar gateway base URL (default: http://127.0.0.1:8799).
# Read by apps/agent/src/routes/{sources,triage,thread}.ts.
MX_GATEWAY_URL=
```

**3d — web section + secrets cross-reference** (append a web section anywhere sensible, e.g. after the Notification Channels section, and extend the file tail after the existing `HOME` block):

```
# ── Web Dashboard (apps/web) ─────────────────────────────────────────

# Optional: The single Nexus agent the web app attaches to, e.g.
# http://<agent-tailscale-ip>:7400. NEXT_PUBLIC_* — inlined at build time.
# Unset => the app renders a "configure agent URL" message instead of crashing.
# Read by: apps/web/src/lib/agent-config.ts.
NEXT_PUBLIC_NEXUS_AGENT_URL=
```

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

**Verify**: `grep -c "ELEVENLABS_VOICE_ID=" /home/nyaptor/dev/nx/.env.example` → `0` matches for the bare old name as an assignment (note: `ELEVENLABS_DEFAULT_VOICE_ID=` does not contain the substring `ELEVENLABS_VOICE_ID`, so `grep -c "^ELEVENLABS_VOICE_ID=" .env.example` → `0`), and
`for v in HEALTH_PUSH_INTERVAL_MS MX_GATEWAY_URL ELEVENLABS_DEFAULT_VOICE_ID CRON_RUNS_RETENTION_DAYS BLOAT_RADAR_RETENTION_DAYS SPEC_SESSIONS_RETENTION_DAYS NEXT_PUBLIC_NEXUS_AGENT_URL NEXUS_ATTACH_SECRET APNS_BUNDLE_ID APNS_HOST HEALTH_PUSH_TOKEN_PATH CC_CREDENTIALS_PATH; do grep -q "$v" /home/nyaptor/dev/nx/.env.example || echo "MISSING $v"; done` → no output.

### Step 4: Reverse doc-rot guard — every added name has a real source read

```bash
for v in APNS_BUNDLE_ID APNS_HOST HEALTH_PUSH_TOKEN_PATH CC_CREDENTIALS_PATH \
         HEALTH_PUSH_INTERVAL_MS MX_GATEWAY_URL ELEVENLABS_DEFAULT_VOICE_ID \
         CRON_RUNS_RETENTION_DAYS BLOAT_RADAR_RETENTION_DAYS SPEC_SESSIONS_RETENTION_DAYS \
         NEXT_PUBLIC_NEXUS_AGENT_URL; do
  grep -rq "process.env.$v" /home/nyaptor/dev/nx/apps /home/nyaptor/dev/nx/packages || echo "NO READ: $v"
done
```

**Verify**: no output. If any `NO READ:` line prints, that var's read site was removed since `c67ff12c` — remove that var from your edit (do not document a dead var) and note it in the commit message + plans/README.md row.

### Step 5: H1 gate

Re-run the H1-count command.

**Verify**: output is `11` (or `baseline - 15` if Step 1 found a drifted baseline), AND the name list (`jq -r` variant) contains **none** of the 15 cleared names and **all 11** settled-exclusion names still present (that proves you did not sneak excluded vars in to game the count).

### Step 6: Scope guard + commit

**Verify**: `git -C /home/nyaptor/dev/nx status --porcelain` lists only `.env.example`, `deploy/secrets.env.example`, `plans/README.md` (and possibly `.beads/`). Then commit + push per Git workflow. **Verify**: `git push` exits 0.

## Test plan

No test files: this plan modifies only untested documentation artifacts (`.env.example` files are not imported by any test). The executable verification surface is:

- Step 1 vs Step 5 H1 counts (26 → 11) via `audit-scan --category documentation` — the same deterministic check CI-adjacent audits use.
- Step 4 reverse doc-rot loop (all 11 names grep to `process.env` reads).
- Step 6 scope guard (`git status --porcelain`).

There is deliberately no new test to write; do not create one.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.claude/scripts/bin/audit-scan --project /home/nyaptor/dev/nx --json --category documentation 2>/dev/null | jq '[.findings[] | select(.id=="H1")] | length'` → `11`
- [ ] H1 message list contains none of: the 11 table vars, `APNS_KEY_ID`, `APNS_KEY_PATH`, `APNS_TEAM_ID`, `NEXUS_ATTACH_SECRET`
- [ ] `grep -c "^APNS_BUNDLE_IOS=\|^APNS_BUNDLE_WATCH=" deploy/secrets.env.example` → `0`
- [ ] `grep -c "^ELEVENLABS_VOICE_ID=" .env.example` → `0`
- [ ] Step 4 loop prints nothing (every documented addition has a live `process.env` read)
- [ ] `git status --porcelain` shows no modified files outside `.env.example`, `deploy/secrets.env.example`, `plans/README.md`, `.beads/`
- [ ] No test-only/excluded var (`NEXUS_HEAVY_TESTS`, `NEXUS_PG_TESTS`, `NEXUS_RUN_LIVE_REAPER_TESTS`, `USER`, `NX_BUNDLE_DERIVED_DATA`, `NEXUS_REPO_ROOT`, `NEXUS_SKIP_SCHEMA_CHECK`, `NEXUS_PHONE_PEER`, `NEXUS_PRESENCE_USER`, `NEXUS_TAILSCALE_POLL_MS`, `NEXUS_USAGE_POLL_INTERVAL_MS`) was added to either file: `grep -c "NEXUS_HEAVY_TESTS\|NX_BUNDLE_DERIVED_DATA\|NEXUS_PHONE_PEER" .env.example deploy/secrets.env.example` → `0` per file
- [ ] `plans/README.md` status row updated; `git push` succeeded

## STOP conditions

Stop and report back (do not improvise) if:

- Any deploy artifact (`deploy/*.sh`, `deploy/*.service`, `deploy/*.plist`, `deploy/launchagents/*`, `apps/swift/fastlane/*`) turns out to reference `APNS_BUNDLE_IOS` or `APNS_BUNDLE_WATCH` at execution time — the plan's "no reader anywhere" fact would be stale, and the reconcile direction (example→source vs source→example) becomes a maintainer decision.
- You find source code that *should* read a watch bundle var (e.g. a watch push path added after `c67ff12c`) — that makes the drift a source bug; flag for the maintainer instead of papering over it in docs.
- Your Read/Edit tooling is permission-denied on `.env.example` (some harnesses deny `.env*` paths). Report the denial; do not bypass via shell redirection.
- Step 1 baseline shows one of the 15 target names already cleared (partial overlap with someone else's work on this shared tree).
- Step 5 lands on any number other than the computed target after one re-check of your edits.
- Fixing anything appears to require editing a `.ts`/`.sh`/`.plist` file.

## Maintenance notes

- **Reviewer focus**: confirm zero source files in the diff; confirm the APNS comment block still names the canonical key (`Z3BX2Y72Q7`) and does not introduce any real secret value; confirm excluded vars stayed excluded.
- **Future interaction**: any new `process.env.<NAME>` read in `apps/` or `packages/` will re-raise H1 until documented in `.env.example` (assignment or comment mention). The "Secrets-File Variables" comment block in `.env.example` is the sanctioned way to satisfy H1 for vars whose canonical home is `deploy/secrets.env.example` — extend that block rather than duplicating secret entries.
- **Deliberately deferred** (do not fold in): documenting the tuning knobs `NEXUS_PHONE_PEER`, `NEXUS_PRESENCE_USER`, `NEXUS_TAILSCALE_POLL_MS`, `NEXUS_USAGE_POLL_INTERVAL_MS`, and dev/CI-only `NX_BUNDLE_DERIVED_DATA`, `NEXUS_REPO_ROOT`, `NEXUS_SKIP_SCHEMA_CHECK` — a separate judgment call (they may belong in ops docs, not operator examples). The residual H1 count of 11 is the accepted steady state until that call is made.
- If a watch push path ever ships, `APNS_BUNDLE_ID` becomes ambiguous — that change owns renaming/splitting the var in *source first*, then updating both examples.
