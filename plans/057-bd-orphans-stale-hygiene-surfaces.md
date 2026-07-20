# Plan 057: Surface `bd orphans` + `bd stale` — shipped-but-open detection as a first-class feed

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done. NEVER run `bd` write commands (`--fix`,
> `close`, `update`) yourself — this plan builds read surfaces only.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- apps/agent/src/lib/fleet-exceptions.ts apps/agent/src/routes/exceptions.ts AGENTS.md apps/agent/src/server-request-handler.ts`
> Note: the in-flight openspec proposal `mechanize-route-registry-parity`
> rewrites route registration in `server-request-handler.ts`. If it has
> landed, register the new route via ITS mechanism (helper + registry list)
> instead of the legacy if/else pattern described in Step 3. Any other
> structural mismatch → STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MEDIUM (new bounded-cadence `bd` spawns — must respect the crash-loop lesson; design below caps them)
- **Depends on**: none (composes with 054-056 but shares no functions)
- **Category**: workflow-gap / feature (hygiene automation)
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters

Two recurring, documented failure modes in this repo:

1. **Shipped-but-open beads**: work lands with `[nx-xxxxx]` in the commit
   message but the bead stays open. Concrete recent instances found by the
   Wave 5 audit: the Sentry→OTel migration was code-complete while
   `nx-7qdt6`/`nx-4oy2v` stayed open; the nx-veo5g.5 crash mitigation
   shipped in `44cda6fa` with the bead never closed.
2. **Forgotten-open tail**: 53 open + 19 deferred beads, some untouched for
   months, with no automated sweep.

bd 1.1.0 ships purpose-built commands for exactly these: `bd orphans
--json` (beads referenced in commit messages but still open/in_progress)
and `bd stale --days N --json` (untouched beads). Nothing in the repo runs
either. This plan surfaces both through the agent (dashboard feed) and the
session protocol (AGENTS.md), keeping `--fix`/closing strictly manual.

**Spawn budget (crash-loop constraint, nx-6lrf7)**: `bd orphans` must read
git history and the bead db — it is NOT cheap. It runs ONLY inside the
existing fleet-exceptions SWR refresh (every 5 min, serialized per repo,
already yield-gated), never on the request path.

## Current state

- `apps/agent/src/lib/fleet-exceptions.ts` — computes per-repo exception
  entries (`p0_open`, stale in_progress, ready-head-stale classes) from the
  JSONL store; SWR cache, 5-min TTL, detached refresh; served by
  `routes/exceptions.ts` → web `/radar` + mac menubar. This is the exemplar
  AND the integration point: hygiene entries become new entry kinds in the
  same feed.
- `apps/agent/src/utils/exec.ts` — `execJson` helper used by
  `cached-bead-source.ts` for its cold-start `bd list` spawn (the sanctioned
  way to shell to bd; read its timeout/error contract).
- `AGENTS.md:56+` — "Session Completion" MANDATORY WORKFLOW (file issues →
  quality gates → update issue status → push). The bd-managed block markers
  are `<!-- BEGIN BEADS INTEGRATION ... -->` / `<!-- END BEADS INTEGRATION -->`;
  edits must go OUTSIDE those markers.

## Steps

### Step 1 — Read the shapes first

Run (read-only) in the nexus repo: `bd orphans --json | head -c 2000` and
`bd stale --days 30 --json | head -c 2000`. Record the actual output shapes
in the new module's docstring (they are the contract; the docs guarantee
`--json` stability). If `bd` is unavailable in your environment, STOP and
report — the shapes cannot be guessed.

Also verify `bd orphans` detects this repo's commit-reference style
(`[nx-xxxxx]` brackets and bare `nx-xxxxx`): pick one known orphan from the
output and confirm its ID appears in `git log --oneline -200`. If the
bracket form is NOT detected, record that as a finding in your report (the
session-protocol step in Step 4 still works via bare references).

### Step 2 — Hygiene collector in the fleet refresh

New file `apps/agent/src/lib/beads-hygiene.ts`:

```ts
export interface HygieneEntry { /* mirror fleet-exceptions' entry shape */ }
export async function collectBeadsHygiene(repoPath: string): Promise<{
  orphans: OrphanRow[];   // from `bd orphans --json`, via execJson
  stale: StaleRow[];      // from `bd stale --days 30 --json`
} | null>;                // null on any spawn/parse failure (degrade)
```

- Spawns via `execJson` with the same timeout discipline as
  `cached-bead-source.ts` (read and copy its usage exactly).
- Wire into `fleet-exceptions.ts`'s refresh: for each repo that has a
  `.beads/` dir, AFTER the existing JSONL-derived entries, call
  `collectBeadsHygiene` and emit up to two new entry kinds:
  `orphaned_open` (head = worst orphan, count) and `stale_open`. Follow the
  existing `entry(repo, kind, ...)` construction pattern
  (`fleet-exceptions.ts:163-177` region) exactly.
- Config guard: a module-level `HYGIENE_ENABLED` flag defaulting to
  reading `process.env.NEXUS_BEADS_HYGIENE !== "0"` — an operator
  kill-switch if the added spawns ever misbehave (document in
  `.env.example` — one line, matching its existing format).

### Step 3 — Route exposure

The fleet feed already flows through `GET /exceptions`; the new entry kinds
ride along with NO new route (check `routes/exceptions.ts` passes entries
through untyped or extend its type union). Additionally expose the raw
per-project view: `GET /beads/hygiene?project=<code>` returning the
collector's cached result for one repo — register following the current
route-registration mechanism (see drift note above). If extending the
entry-kind union requires touching `packages/core` types consumed by
Swift/web, extend the union additively (new kinds, no changed fields) and
note that clients ignoring unknown kinds must degrade gracefully — verify
the web radar's handling of an unknown `kind` (read
`apps/web/src/lib/agent-radar-client.ts`).

### Step 4 — Session-protocol wiring (docs)

In `AGENTS.md`, OUTSIDE the managed beads block, extend the Session
Completion workflow's step 3 ("Update issue status") with:

```
   - Run `bd orphans --details` — any bead you shipped this session that
     still shows open here MUST be closed before push. Do not run
     `bd orphans --fix` blind; close each with a reason.
   - Weekly-ish: `bd stale --days 30` and triage (close / defer / re-prioritize).
```

### Step 5 — Tests

Follow `fleet-exceptions.test.ts` patterns (it stubs store reads):

1. collector returns null on spawn failure → no hygiene entries, other
   entries unaffected;
2. orphan rows → `orphaned_open` entry with worst-first head (reuse
   `worstFirst` if exported, else mirror);
3. kill-switch env → no spawns (spy on execJson);
4. entries serialize through `GET /exceptions` (extend the route test).

Verification:

```
bun test apps/agent/src/lib/ apps/agent/src/routes/exceptions.test.ts 2>/dev/null || bun test apps/agent/src/lib/
pnpm --filter @nexus/agent typecheck
```

## Done criteria (machine-checkable)

- `grep -c "bd\", \"orphans\|orphans" apps/agent/src/lib/beads-hygiene.ts` → ≥ 1; spawns ONLY from the refresh path (no route handler imports the collector directly except the cached-view route).
- `bun test apps/agent/src/lib/` → 0 failures, ≥ 4 new tests.
- AGENTS.md diff touches only lines outside the BEADS INTEGRATION markers.
- `.env.example` documents `NEXUS_BEADS_HYGIENE`.
- Step-1 recorded shapes present in the module docstring.

## Out of scope — do not touch

- Auto-closing anything (`bd orphans --fix` stays human-triggered, always).
- Swift UI rendering of the new entry kinds (follow-up; entries degrade as
  generic exceptions meanwhile — verify, per Step 3).
- The scheduled/cron layer (if the maintainer wants a daily digest instead,
  that is a scheduling decision on top of this feed).

## STOP conditions

- `bd` binary absent or `--json` shapes unobtainable (Step 1) → STOP.
- If adding hygiene spawns to the refresh pushes a full fleet refresh past
  ~30s wall-clock on this machine (time it), STOP and report — the cadence
  or scope needs maintainer input, not silent slowness.
- If the exceptions entry union is consumed exhaustively (switch without
  default) in Swift, report it — additive kinds would crash decode there.

## Maintenance notes

- If plan 061 (molecules) lands, `bd mol progress`-based wave entries could
  join this same feed — keep entry kinds string-extensible.
- `bd orphans` correlation quality depends on commit-message discipline;
  the `[nx-xxxxx]` convention is now load-bearing — note it in review.
