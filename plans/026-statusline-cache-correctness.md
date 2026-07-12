# Plan 026: Statusline cache correctness — stale-before-parse, shared-tmp race, GC gap, usage staleness bound

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED, append
> `spec-impact: <slug>[, ...]` or `spec-impact: none` per the executor
> handoff rule.
>
> **Drift check (run first)**:
> `git diff --stat b7096486..HEAD -- apps/nexus-statusline/src/index.ts apps/nexus-statusline/src/index.test.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. Plan 025
> intentionally edits the SAME file (this plan is sequenced AFTER 025) — see
> "Coordination with plan 025" in Current state for the one expected drift
> and how to adapt. Any OTHER mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/025-*.md (soft ordering — same file, run 026 after 025; 026 is still executable if 025 has not landed). Run BEFORE plan 031 (statusline file split).
- **Category**: bug
- **Planned at**: commit `b7096486`, 2026-07-11

## Why this matters

`apps/nexus-statusline/src/index.ts` (the CC statusline binary, compiled via
`bun build --compile`) leans on a family of cache files under
`~/.claude/scripts/state/`. Four small lifecycle defects live there today, all
verified at commit `b7096486`:

1. A corrupt-but-fresh agent cache file suppresses its own refresh — the
   specs/roadmap/drift statusline rows silently vanish for up to 5 minutes,
   and the code contradicts its own catch comment ("treat as stale").
2. Two detached refresh spawns share a fixed per-project `${cachePath}.tmp`,
   so two concurrent CC sessions in the same project can interleave curl
   output into one tmp file, committing corrupt bytes with a fresh mtime —
   which then triggers defect 1.
3. The opportunistic GC only prunes `session-context.*` files;
   `statusline-ctx.<sessionId>.json` and `statusline-speed.<sessionId>.json`
   accumulate forever (5 `statusline-ctx.*` files already sit in
   `~/.claude/scripts/state/` days after shipping; CC never reuses session
   ids, so nothing else unlinks them).
4. `getPolledUsage` returns the poller-written usage cache with NO staleness
   check — the pre-consolidation code (baseline `c67ff12c`) had a 300s TTL
   that commit `54a8453`-era consolidation removed. If `nexus-agent` is down
   or the new binary undeployed, the statusline renders arbitrarily old 5h/7d
   usage bars with no cue, indefinitely. The writer already populates
   `fetched_at`; no consumer reads it.

This plan fixes all four plus one settled docstring polish. No behavior
outside the statusline app changes.

## Current state

**Repo facts** (inline — the executor has no other context):

- pnpm + Bun monorepo, NOT standard T3 (no tRPC). Tests are `bun:test`,
  colocated as `<module>.test.ts`.
- Quality gates: `pnpm typecheck`, `pnpm lint`, `bun test` (root discovery of
  all `*.test.ts`), `scripts/lint-sql-safety.sh`.
- CI (`.github/workflows/ci.yml`) is RED on main since 2026-07-10 solely due
  to a lint-sql-safety false positive that plan 023 fixes. Until 023 lands,
  the bar for this plan is: **no new failures attributable to changed
  files**.
- `apps/nexus-statusline` has NO `@nexus/core` dependency (devDeps only:
  `@types/bun`, `typescript`). This plan adds NO dependency — it does not
  need `safeSpawn`; spawn-hardening (shell-string → argv/positional-param
  conversion) is plan 025's job, not this plan's.
- The statusline binary's `src/index.ts` exports exist solely for
  `src/index.test.ts` — adding a test-only export follows existing
  convention (22 already exist).
- Leo works directly in `~/dev/personal/nexus`; execute in a worktree and
  expect main to advance mid-run (hence the drift check).

**Files**:

- `apps/nexus-statusline/src/index.ts` (1607 lines) — the whole statusline;
  all four defects live here.
- `apps/nexus-statusline/src/index.test.ts` (1309 lines) — the existing
  suite; new tests go here.
- `apps/agent/src/services/statusline-usage-file.ts` — the agent-side writer
  of `usage-cache.json`. READ-ONLY for this plan; cited to prove `fetched_at`
  is populated.

### Defect 1 — stale-before-parse (`readCachedAgentJson`, index.ts:1011-1034)

```ts
// apps/nexus-statusline/src/index.ts:1011-1034 (at b7096486)
function readCachedAgentJson<T>(cachePath: string, url: string): T | null {
  let data: T | null = null;
  let stale = true;
  try {
    stale = Date.now() - statSync(cachePath).mtimeMs > BEAD_LINE_CACHE_TTL_MS;
    data = JSON.parse(readFileSync(cachePath, "utf-8")) as T;
  } catch {
    // No cache yet / unparseable — treat as stale, return null.
  }

  if (stale) {
    const child = childProcess.spawn(
      "sh",
      [
        "-c",
        `curl -sf --max-time 3 "${url}" > "${cachePath}.tmp" 2>/dev/null && mv "${cachePath}.tmp" "${cachePath}"`,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }

  return data;
}
```

The bug: line 1015 assigns `stale` from the fresh mtime BEFORE line 1016's
`JSON.parse` throws. For a fresh-mtime-but-corrupt file: `statSync` succeeds →
`stale = false`, then `JSON.parse` throws into the empty catch, which never
resets `stale`. Result: returns null (row omitted via `getSpecsLine`
:1040, `getRoadmapLine` :1059, `getDriftLine` :1166) AND skips the refresh
spawn — the corrupt cache is not revalidated until the 5-min TTL
(`BEAD_LINE_CACHE_TTL_MS = 300_000`, index.ts:912) expires. The catch comment
promises "treat as stale" but the code does not.

### Defect 2 — shared fixed tmp names (index.ts:888 and :1026)

Both detached refresh spawns redirect into a shared per-project
`${cachePath}.tmp` — `readCachedAgentJson` above (:1026), and
`getRoadmapPulse`:

```ts
// apps/nexus-statusline/src/index.ts:885-898 (at b7096486)
    if (stale) {
      const child = childProcess.spawn(
        "sh",
        ["-c", `"${PULSE_BIN}" --line > "${cachePath}.tmp" 2>/dev/null && mv "${cachePath}.tmp" "${cachePath}"`],
        {
          cwd: projectDir,
          detached: true,
          stdio: "ignore",
          // Producer-side radar gate: cc's roadmap-pulse skips radar rungs when 0
          env: { ...process.env, PULSE_RADAR: isBb ? "1" : "0" },
        },
      );
      child.unref();
    }
```

Cache paths are per-PROJECT, shared across sessions
(`roadmap-pulse.${projectCode}.line` at :871-874,
`bead-specs.${code}.json` at :1043-1046, `bead-roadmap.${code}.json` at
:1062-1064, `queue-head.${code}.json` at :1169-1171). Two sessions in the
same project rendering inside the refresh window both spawn writers against
the same tmp; independent O_TRUNC fds interleave, and after the first `mv`
the second writer's fd keeps writing into the renamed inode at `cachePath`,
committing corrupt bytes with a fresh mtime — which defect 1 then turns into
a 5-minute refresh blackout. Suffixing tmp names with the spawned shell's
`$$` closes the class.

Note also: `curl -sf ... > tmp` CREATES the tmp file even when curl fails
(the shell opens the redirect before curl runs), and `&&` then skips the
`mv`. With a fixed name that orphan is bounded (one per cache path — you can
see `bead-roadmap.brown.json.tmp` etc. in `~/.claude/scripts/state/` today);
with a pid suffix each failed attempt would leave a UNIQUE orphan. Step 2
therefore adds `|| rm -f <tmp>` so failure cleans up after itself.

The per-SESSION tmp writers at :591 (`defaultWriteSnapshot`), :692
(`writeSessionContext`), :785 (`defaultWriteSpeedCache`) are keyed by
session/pane id and cannot collide cross-session — they are OUT of scope.

**Coordination with plan 025**: plan 025 (spawn-security seam) may rewrite
these two `sh -c` sites to a constant script with positional shell
parameters (e.g. `spawn("sh", ["-c", SCRIPT, "sh", binPath, cachePath, url])`
where SCRIPT references `"$1"`, `"$2"`). If you find that shape instead of
the excerpts above, the adaptation is mechanical: inside the constant script,
change every `"$N.tmp"` to `"$N.$$.tmp"` and add the `|| rm -f "$N.$$.tmp"`
tail — the principle (tmp path unique per spawned shell, cleaned on failure)
is unchanged. If the sites no longer use a shell at all (e.g. curl replaced
by TS-side fetch), STOP and report — the race fix needs redesign.

### Defect 3 — GC prefix gap (`gcSessionContext`, index.ts:719-738)

```ts
// apps/nexus-statusline/src/index.ts:708-738 (at b7096486)
/** Orphaned session-context files older than this are pruned by the GC. */
const SESSION_CONTEXT_TTL_SECS = 6 * 60 * 60;
// ... docstring ...
function gcSessionContext(): void {
  if (Math.floor(Math.random() * 100) !== 0) return; // 1-in-100: skip the scan
  try {
    const dir = join(homedir(), ".claude/scripts/state");
    const cutoff = nowSecs() - SESSION_CONTEXT_TTL_SECS;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("session-context.") || !name.endsWith(".json")) {
        continue;
      }
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs / 1000 < cutoff) unlinkSync(full);
      } catch {
        // a file vanishing mid-scan (concurrent render) is fine — skip it
      }
    }
  } catch {
    // fail-soft — GC never crashes the render
  }
}
```

Only `session-context.*` is pruned. The two other per-session file families —
`statusline-ctx.${sessionId}.json` (written via `ctxSnapshotPath` :571-576 by
`defaultWriteSnapshot` on every populated frame) and
`statusline-speed.${sessionId}.json` (`speedCachePath` :756-761) — have zero
unlink sites anywhere and accumulate forever. The 6h TTL is safe for all
three families: the ctx snapshot is only consumed within a 10-min freshness
window (`CTX_FRESH_WINDOW_SECS = 600`, :148) and the speed cache within a 2s
window (`SPEED_WINDOW_MS = 2_000`, :152). `gcSessionContext` is called once
per render from `main()` at :1581 and is currently NOT exported.

### Defect 4 — no staleness bound on the polled usage cache (index.ts:461-469)

```ts
// apps/nexus-statusline/src/index.ts:461-469 (at b7096486)
async function getPolledUsage(): Promise<UsageResponse | null> {
  try {
    const content = readFileSync(usageCachePath(), "utf-8");
    const cached: CachedUsage = JSON.parse(content);
    return cached?.data ?? null;
  } catch {
    return null;
  }
}
```

`CachedUsage` (index.ts:132-135) is `{ fetched_at: number; data: UsageResponse }`.
The writer populates `fetched_at` in unix SECONDS:

```ts
// apps/agent/src/services/statusline-usage-file.ts:126-129 (read-only citation)
    const payload: CachedUsage = {
      fetched_at: Math.floor(Date.now() / 1000),
      data,
    };
```

No consumer reads it on the usage path (the only `fetched_at` reader in
index.ts is the PROFILE cache at :515). The baseline before the polling
consolidation had `if (nowSecs() - cached.fetched_at < USAGE_CACHE_TTL)
return cached.data;` with `USAGE_CACHE_TTL = 300` plus a self-fetch fallback
— both removed. Mitigation context: `resolveUsage` (:499-506) prefers stdin
`rate_limits` via `buildStdinUsage` (:480-490), but that returns null when
either window lacks `used_percentage`, so the stale-cache fallback is a live
path.

**DESIGN DECISION (settled here, do not re-open)**: hard TTL drop at 30
minutes (`USAGE_CACHE_MAX_AGE_SECS = 30 * 60`) — the segment is OMITTED when
the cache is older. Rationale: 30 min is consistent with the
pre-consolidation 300s intent while tolerant of the agent poller's cadence +
backoff headroom; and omission is this file's established degraded mode
(`resolveContext` omits on suspicious zero, `readCachedAgentJson` omits on
miss) — the renderer has no "stale marker" concept, and inventing one is out
of scope. A dead agent now degrades to a missing usage segment instead of
frozen bars.

### Ride-along — `writeSessionContext` docstring phrasing ONLY (index.ts:669-706)

SETTLED (2-of-3 verifiers): the null-usedPct early-return at :690
(`if (!pane || usedPct == null) return;`) is BY DESIGN. Do NOT change the
guard. The docstring's final sentence (:680-682) is the only defect:

```
 * ... A null/undefined `usedPct`
 * (the suspicious-zero guard omitted the segment this frame) is a no-op, leaving
 * any prior good value in place rather than clobbering it with a zero. The model
 * letter is written whenever available — independently of the `usedPct` guard —
 * and omitted (no `model` key) when there is no model on this frame.
```

"independently of the `usedPct` guard" is false — on a null-usedPct frame
NOTHING is written, letter included. Step 5 rewords that one sentence.

### Live-tree drift observed while authoring

At authoring time HEAD was `d458ef8e` (one `chore(beads)` commit past
`b7096486`); `git diff b7096486..HEAD -- apps/nexus-statusline/` was EMPTY,
and the only uncommitted changes were in
`apps/agent/src/services/credential-usage-poller.{ts,test.ts}` — not in
scope. All excerpts above are fresh reads matching `b7096486` exactly.

## Commands you will need

| Purpose | Command (from repo root) | Expected on success |
| --- | --- | --- |
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 (no NEW errors in changed files) |
| Statusline suite | `bun test apps/nexus-statusline` | all pass (113 existing + new) |
| Full suite | `bun test` | no new failures attributable to changed files |
| SQL-safety | `bash scripts/lint-sql-safety.sh` | may be RED from the known plan-023 false positive; MUST NOT flag either file this plan touches |

Note: `apps/nexus-statusline/package.json`'s `test` script is
`echo 'no tests yet'` (false green) — do NOT use it, and do NOT fix it (it
belongs to a concurrent plan). Use root `bun test apps/nexus-statusline`.

## Scope

**In scope** (the only files you may modify):

- `apps/nexus-statusline/src/index.ts`
- `apps/nexus-statusline/src/index.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `apps/nexus-statusline/package.json` — the false-green `test` script and
  any `@nexus/core` dependency decision belong to concurrent plans (027/031
  territory). This plan adds no dependency.
- The `sh -c` → argv/positional-param spawn-security conversion — plan 025.
- Splitting index.ts into modules — plan 031 (this plan runs BEFORE it).
- `writeSessionContext`'s `usedPct == null` early-return behavior — SETTLED
  by design; docstring phrasing only.
- The per-session tmp writers at index.ts:591, :692, :785 — session/pane-keyed,
  no cross-session collision; renaming their tmp files is churn.
- `apps/agent/src/services/statusline-usage-file.ts` — writer is correct;
  cited read-only.
- Pruning the pre-existing fixed-name `*.tmp` orphans in
  `~/.claude/scripts/state/` — bounded legacy debris, not code.
- `.github/workflows/ci.yml`, `scripts/lint-sql-safety.sh` — plan 023.

## Git workflow

- Execute in a worktree (plans execute in worktrees; Leo works directly in
  `~/dev/personal/nexus` — expect main to advance mid-run).
- Branch: `advisor/026-statusline-cache-correctness` (matches prior rows in
  `plans/README.md`, e.g. `advisor/011-parallelize-git-discovery`).
- Single commit, conventional style, message via file + `git commit -F`
  (repo exemplar: `feat(nexus-statusline): write model letter into
  session-context cache`). Suggested:
  `fix(nexus-statusline): cache lifecycle — stale-on-corrupt, pid tmp, GC prefixes, usage TTL`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix stale-before-parse in `readCachedAgentJson`

In `apps/nexus-statusline/src/index.ts`, inside `readCachedAgentJson`
(:1011), add one line to the catch block:

```ts
  } catch {
    // No cache yet / unparseable — treat as stale, return null.
    stale = true; // a corrupt-but-fresh cache must still trigger a refresh
  }
```

(When the file is merely missing, `statSync` throws before the `stale`
assignment, so `stale` is already `true` — the added line is a no-op there
and load-bearing only for the corrupt-fresh case.)

**Verify**: `pnpm typecheck` → exit 0, and
`grep -A3 'No cache yet / unparseable' apps/nexus-statusline/src/index.ts | grep -c 'stale = true'` → `1`

### Step 2: pid-suffix the two shared refresh tmp files (+ cleanup on failure)

In the SAME file, two sites. In `getRoadmapPulse` (:888 at b7096486), change
the spawn script string to:

```ts
["-c", `"${PULSE_BIN}" --line > "${cachePath}.$$.tmp" 2>/dev/null && mv "${cachePath}.$$.tmp" "${cachePath}" || rm -f "${cachePath}.$$.tmp"`],
```

In `readCachedAgentJson` (:1026), change the script string to:

```ts
`curl -sf --max-time 3 "${url}" > "${cachePath}.$$.tmp" 2>/dev/null && mv "${cachePath}.$$.tmp" "${cachePath}" || rm -f "${cachePath}.$$.tmp"`,
```

Mechanics (so you don't second-guess): inside a TS template literal `$$` is
literal text (only `${` opens interpolation); inside the double-quoted shell
word, `$$` expands to the spawned shell's pid, making the tmp path unique per
concurrent refresh. The `|| rm -f` tail removes the tmp when the producer
fails (the `>` redirect creates the file even on failure) so pid-unique
orphans cannot accumulate.

If plan 025 already landed and reshaped these sites, adapt per
"Coordination with plan 025" in Current state; if the shape is
unrecognizable, STOP.

**Verify**: `grep -c '\.\$\$\.tmp' apps/nexus-statusline/src/index.ts` → `6`
and `grep -n '"${cachePath}.tmp"' apps/nexus-statusline/src/index.ts` → no
output (exit 1).

### Step 3: Extend `gcSessionContext` to all three per-session file families (+ test seams)

Replace `gcSessionContext` (:719-738) with an exported, seam-injectable
version. Keep `SESSION_CONTEXT_TTL_SECS` (6h) as the single TTL — it exceeds
every consumer's freshness window (ctx 10 min, speed 2 s). Target shape:

```ts
/** Injectable seams for `gcSessionContext` (deterministic in tests). */
interface GcDeps {
  dir?: string; // state dir override (tests use a tmpdir)
  random?: () => number; // 1-in-100 gate source
}

/** Per-session state-file prefixes the GC owns. All are session/pane-keyed
 * and never reused by CC, so nothing else ever unlinks them. */
const GC_STATE_PREFIXES = [
  "session-context.",
  "statusline-ctx.",
  "statusline-speed.",
] as const;

export function gcSessionContext(deps: GcDeps = {}): void {
  const random = deps.random ?? Math.random;
  if (Math.floor(random() * 100) !== 0) return; // 1-in-100: skip the scan
  try {
    const dir = deps.dir ?? join(homedir(), ".claude/scripts/state");
    const cutoff = nowSecs() - SESSION_CONTEXT_TTL_SECS;
    for (const name of readdirSync(dir)) {
      if (
        !GC_STATE_PREFIXES.some((p) => name.startsWith(p)) ||
        !name.endsWith(".json")
      ) {
        continue;
      }
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs / 1000 < cutoff) unlinkSync(full);
      } catch {
        // a file vanishing mid-scan (concurrent render) is fine — skip it
      }
    }
  } catch {
    // fail-soft — GC never crashes the render
  }
}
```

Update the function's docstring to name all three prefixes. The call site in
`main()` (:1581, `gcSessionContext();`) needs NO change — the default param
covers it. The injectable-deps-object pattern copies `CtxResolverDeps`
(:562-569) and `SpeedDeps` (:748-754); the export-for-tests move matches the
file's existing convention.

**Verify**: `pnpm typecheck` → exit 0, and
`grep -c 'statusline-ctx\.\|statusline-speed\.' apps/nexus-statusline/src/index.ts`
→ at least `4` (the two path builders + the two new GC prefix entries).

### Step 4: Restore a staleness bound on the polled usage cache

Near the other config constants (index.ts:141-153), add:

```ts
// Polled-usage cache: older than this → treat as absent (agent down/undeployed).
// 30 min = poller cadence + backoff headroom; pre-consolidation intent was 300s.
const USAGE_CACHE_MAX_AGE_SECS = 30 * 60;
```

Add a pure, exported helper right above `getPolledUsage` (:461) and route
`getPolledUsage` through it:

```ts
/**
 * Apply the staleness bound to a parsed usage cache. Exported for tests.
 * Missing/non-numeric `fetched_at` → treat as stale (null). The writer
 * (apps/agent statusline-usage-file.ts) always writes unix-seconds
 * `fetched_at`, so a well-formed cache only goes null by aging out.
 */
export function polledUsageFromCache(
  cached: CachedUsage | null | undefined,
  atSecs: number,
): UsageResponse | null {
  if (!cached || typeof cached.fetched_at !== "number") return null;
  if (atSecs - cached.fetched_at > USAGE_CACHE_MAX_AGE_SECS) return null;
  return cached.data ?? null;
}

async function getPolledUsage(): Promise<UsageResponse | null> {
  try {
    const content = readFileSync(usageCachePath(), "utf-8");
    const cached: CachedUsage = JSON.parse(content);
    return polledUsageFromCache(cached, nowSecs());
  } catch {
    return null;
  }
}
```

Extend `getPolledUsage`'s docstring (:450-460) with one sentence, e.g.:
"Caches older than `USAGE_CACHE_MAX_AGE_SECS` are treated as absent — a dead
or undeployed poller degrades to an omitted usage segment, never frozen
bars." Do NOT reintroduce any self-fetch fallback — the poller being the
sole `/api/oauth/usage` caller is the consolidation's whole point (429 fix).

**Verify**: `pnpm typecheck` → exit 0, and
`grep -c 'USAGE_CACHE_MAX_AGE_SECS' apps/nexus-statusline/src/index.ts` → `3`

### Step 5: Reword the `writeSessionContext` docstring sentence (behavior untouched)

Replace ONLY the final sentence of the docstring paragraph at :680-682
("The model letter is written whenever available — independently of the
`usedPct` guard — and omitted (no `model` key) when there is no model on this
frame.") with:

```
 * On frames that pass the `usedPct` gate, the model letter is included
 * whenever available and omitted (no `model` key) when the frame carries no
 * model; a null-`usedPct` frame writes nothing at all, so the prior
 * snapshot's letter is preserved along with its pct.
```

Zero code changes in this step — the `if (!pane || usedPct == null) return;`
guard at :690 is settled by design.

**Verify**: `grep -c 'independently of the' apps/nexus-statusline/src/index.ts`
→ `0`, and `git diff apps/nexus-statusline/src/index.ts` shows no non-comment
change in `writeSessionContext`.

### Step 6: Add the regression tests

All in `apps/nexus-statusline/src/index.test.ts`. Add `utimesSync` to the
existing `node:fs` import line (:9) and `homedir` to a `node:os` import
(`tmpdir` is already imported at :10). Import `gcSessionContext` and
`polledUsageFromCache` in the existing import block from `./index` (:16).
Four new `describe` blocks — case list in Test plan below. Structural
exemplars already in the file:

- spawn spying: `describe("getSpecsLine / getRoadmapLine — stale-while-revalidate cache")`
  (:420-441) — `spyOn(childProcess, "spawn").mockImplementation((() => ({ unref() {} })) as unknown as typeof childProcess.spawn)`,
  restore in `finally`.
- tmpdir + cleanup: `describe("isBbProject + radar gate")` (:841-853) —
  `mkdtempSync(join(tmpdir(), "nx-..."))` + `rmSync(..., { recursive: true, force: true })`.
- real-state-dir usage with unique fake project code + cleanup:
  the `zzznope` pattern at :422-439 (`deriveProjectCode` of
  `/home/nyaptor/dev/<code>` is `<code>` — index.ts:174-183).

**Verify**: `bun test apps/nexus-statusline` → all pass, including the new
tests (expect >= 9 new).

### Step 7: Full gates

**Verify**:
- `pnpm typecheck` → exit 0
- `pnpm lint` → no new errors in the two changed files
- `bun test` → no new failures attributable to changed files
- `git status --short` → only the two in-scope files modified

## Test plan

New `describe` blocks in `apps/nexus-statusline/src/index.test.ts`:

1. `readCachedAgentJson — corrupt-fresh cache triggers refresh` (via
   `getSpecsLine`, model after :420-441):
   - Setup: unique fake code (e.g. `zzcorrupt`), write `"{ not json"` to
     `join(homedir(), ".claude/scripts/state/bead-specs.zzcorrupt.json")`
     (mkdir the dir `{ recursive: true }` first), spawn spied.
   - Assert `getSpecsLine("/home/nyaptor/dev/zzcorrupt", "http://localhost:7400")`
     returns null AND the spawn spy fired once (this test FAILS on unfixed
     code — the whole point). Cleanup: `unlinkSync` the cache file in `finally`.
2. `refresh spawns use pid-unique tmp paths`:
   - Spawn spied; call `getSpecsLine` (no cache → stale) and `getRoadmapPulse`
     (tmpdir project, model after :888-902); assert each spawn's args string
     contains `.$$.tmp` and `rm -f`, and does NOT contain `.tmp"` preceded by
     the bare cache path (i.e. no fixed `${cachePath}.tmp` remains).
3. `gcSessionContext — prunes all three prefixes, honors gate and TTL`:
   - Setup: `mkdtempSync` dir; create aged files (mtime 7h ago via
     `utimesSync(path, t, t)` with `t = Date.now()/1000 - 7*3600`):
     `session-context.%9.json`, `statusline-ctx.old.json`,
     `statusline-speed.old.json`; plus a FRESH `statusline-ctx.new.json` and
     an aged NON-owned file `usage-cache.json`.
   - `gcSessionContext({ dir, random: () => 0 })` → the three aged owned
     files are gone; fresh file and `usage-cache.json` survive.
   - `gcSessionContext({ dir, random: () => 0.5 })` on a fresh copy → nothing
     deleted (gate skips the scan).
4. `polledUsageFromCache — staleness bound` (pure, hermetic — never touch the
   real `usage-cache.json`):
   - fresh cache (`fetched_at = now - 60`) → returns `data`.
   - stale cache (`fetched_at = now - 31*60`) → null.
   - boundary: `fetched_at = now - 30*60` exactly → returns `data` (bound is
     strict `>`).
   - missing `fetched_at` / null cached → null.

Verification: `bun test apps/nexus-statusline` → all pass; then revert Step 1
mentally — test 1 is the regression pin, tests 2-4 pin steps 2-4.

## Done criteria

Machine-checkable. ALL must hold (run from repo root):

- [ ] `pnpm typecheck` exits 0
- [ ] `bun test apps/nexus-statusline` exits 0 with >= 9 new passing tests
- [ ] `bun test` shows no new failures attributable to the two changed files
- [ ] `grep -A3 'No cache yet / unparseable' apps/nexus-statusline/src/index.ts | grep -c 'stale = true'` prints `1`
- [ ] `grep -c '\.\$\$\.tmp' apps/nexus-statusline/src/index.ts` prints `6`
- [ ] `grep -n '"${cachePath}.tmp"' apps/nexus-statusline/src/index.ts` prints nothing (exit 1)
- [ ] `grep -c 'statusline-ctx\.' apps/nexus-statusline/src/index.ts` >= `2` (path builder + GC prefix)
- [ ] `grep -c 'USAGE_CACHE_MAX_AGE_SECS' apps/nexus-statusline/src/index.ts` prints `3`
- [ ] `grep -c 'independently of the' apps/nexus-statusline/src/index.ts` prints `0`
- [ ] `git status --short` shows only `apps/nexus-statusline/src/index.ts` and `apps/nexus-statusline/src/index.test.ts` modified
- [ ] `plans/README.md` status row updated with `spec-impact:` note

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows changes to either in-scope file AND the mismatch is
  anything other than plan 025's spawn-site reshape described under
  "Coordination with plan 025" (constant script + positional params). In
  particular: if the two refresh sites no longer spawn a shell at all, STOP.
- You are tempted to change `writeSessionContext`'s
  `if (!pane || usedPct == null) return;` guard, `resolveContext`'s zero
  handling, or to add a self-fetch/network fallback to `getPolledUsage` —
  all settled; docstring/TTL-read only.
- The fix appears to require touching `package.json`, `@nexus/core`, or any
  `apps/agent` file.
- Test 1 (corrupt-fresh) passes BEFORE you apply Step 1 — that means the
  code already changed and this plan is stale.
- A step's verification fails twice after a reasonable fix attempt, or
  `bun test apps/nexus-statusline` flakes on the shared
  `~/.claude/scripts/state` dir (existing suite already writes there; if a
  collision with a live session appears, report rather than loosening
  cleanup).

## Maintenance notes

- Plan 031 splits index.ts along its banner seams — the exports added here
  (`gcSessionContext`, `polledUsageFromCache`) become real module boundaries
  in that split; keep their names.
- `GC_STATE_PREFIXES` is the single registry of GC-owned per-session file
  families. Any future per-session state file under
  `~/.claude/scripts/state/` MUST be added there, or it inherits defect 3.
- The GC matches only `.json` suffixes — `.json.tmp` stragglers from the
  per-session writers (:591/:692/:785) are not swept; they are bounded (one
  per key) and were deliberately left alone. A `*.tmp`-age sweep is a
  possible follow-up, not done here.
- `USAGE_CACHE_MAX_AGE_SECS = 30 min` assumes the agent poller ticks well
  inside that window. If the poller cadence ever stretches past ~20 min,
  bump this constant in the same change — otherwise healthy deploys will
  flicker the usage segment.
- Reviewer focus: (a) Step 2's shell strings — confirm `$$` is inside the
  double-quoted shell word and NOT accidentally interpolated by TS; (b) the
  corrupt-fresh test actually fails on pre-fix code; (c) no behavior change
  in `writeSessionContext`.
- Deferred out of this plan: stale-marker rendering for old usage data
  (rejected — omission is the file's uniform degraded mode), pruning legacy
  fixed-name `*.tmp` orphans already on disk.
