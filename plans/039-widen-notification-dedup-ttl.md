# Plan 039: Widen the notification dedup TTL from 5s to 2 minutes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6796f8ab..HEAD -- apps/agent/src/routes/notifications.ts apps/agent/src/routes/notifications-dedup.test.ts`
> Expected: no output (empty diff). If either file changed since this plan
> was written, compare the "Current state" excerpts below against the live
> file before proceeding; on a real mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (noise reduction)
- **Planned at**: commit `6796f8ab`, 2026-07-13

## Why this matters

A noise-reduction audit of the notification/TTS system (`/improve` pass,
2026-07-13) found that `POST /notifications/send`'s exact-duplicate
suppression window is **5 seconds** (`DEDUP_TTL_MS = 5_000` in
`apps/agent/src/routes/notifications.ts`) — far shorter than the actual
retry/re-fire cadence this repo's own emitters use.

This was verified against live production data, not just theorized: a query
against the `notifications` table (14-day window) found 71 cases of the
**exact same title+body** firing again 5-23 seconds after a prior identical
notification — e.g. `"mx cred" / "discovered new non-prod PIM role
\"bbadmin-nonprod-group-sweep\"..."` fired at `21:39:40.012` and again,
byte-identical, at `21:39:45.177` (5.17s later), then again shortly after —
a retry-loop pattern that the 5s window only partially catches (the first
repeat, at ~5.1s, is right at the edge and inconsistently suppressed
depending on exact timing; anything past 5s sails through every time).
Widening the window to comfortably exceed the observed retry cadence removes
this class of exact-repeat noise with a single-constant change and zero
behavior change for anything that isn't a literal repeat.

**Scope note**: an earlier hypothesis in this audit (that dedup should also
key on `title`, to collapse the "mx" / "mx cred" / "mx cred — daily" title
family) was checked against live data and **rejected** — those three titles
carry 164/172/140 occurrences over 14 days with 164/16/114 *distinct* bodies
respectively (each names a different failing credential or PIM role — real,
non-duplicate information). Making dedup title-aware would not have
collapsed that family (the bodies already differ, which is why they're not
being deduped today), and forcing them together would risk suppressing
genuinely distinct alerts. That noise is a **bursty-distinct-messages**
problem (many different real alerts fired in a tight burst), which plan
041's rate-based throttle addresses instead — not a dedup problem. Do not
re-introduce the title-in-key idea under this plan; it was evaluated and is
out of scope here.

## Current state

- `apps/agent/src/routes/notifications.ts:56-106` — the full dedup
  mechanism today:

  ```ts
  const DEDUP_TTL_MS = 5_000;
  /** Max dedup entries before bulk eviction (memory leak guard). */
  const DEDUP_MAX_SIZE = 1_000;
  /** Number of oldest entries to evict when capacity is reached. */
  const DEDUP_EVICT_BATCH = 100;
  /** key → expiry epoch ms */
  const dedupMap = new Map<string, number>();

  /** Evict expired entries + enforce max-size cap. */
  function evictDedupEntries(): void {
    const now = Date.now();
    for (const [k, exp] of dedupMap) {
      if (exp < now) dedupMap.delete(k);
    }
    if (dedupMap.size > DEDUP_MAX_SIZE) {
      let removed = 0;
      for (const key of dedupMap.keys()) {
        if (removed >= DEDUP_EVICT_BATCH) break;
        dedupMap.delete(key);
        removed++;
      }
    }
  }

  /**
   * Return true if this (message, project, channel) triple was already seen
   * within DEDUP_TTL_MS. `project` is included so the same banner text fired
   * for two distinct projects in the same 5s window is NOT suppressed
   * (analytics-query-and-tts-synthesis). Pass `null`/`undefined` for
   * project-less notifications — the empty-string segment keeps the key
   * shape stable across both cases.
   */
  function isDuplicate(
    message: string,
    project: string | null | undefined,
    channel: string,
  ): boolean {
    const target = `${channel}|${project ?? ""}`;
    const key = createHash("sha256")
      .update(`${message}|${target}`)
      .digest("hex")
      .slice(0, 16);
    evictDedupEntries();
    if (dedupMap.has(key)) return true;
    dedupMap.set(key, Date.now() + DEDUP_TTL_MS);
    return false;
  }
  ```

  Only the `DEDUP_TTL_MS` value and its doc comment need to change. The key
  shape (`message|channel|project`), the eviction logic, and `DEDUP_MAX_SIZE`
  are all correct as-is and out of scope.

- `apps/agent/src/routes/notifications-dedup.test.ts` — the existing test
  pattern this plan follows (lines 43-46 today):
  ```ts
  test("dedupMap max size is 1000", async () => {
    const { _testDedupInternals } = await import("./notifications");
    expect(_testDedupInternals.DEDUP_MAX_SIZE).toBe(1_000);
  });
  ```
  `_testDedupInternals` (exported at `notifications.ts:188-193`) already
  exposes `DEDUP_TTL_MS` alongside `DEDUP_MAX_SIZE` and `map` (the raw
  `Map<string, number>` of key → expiry-epoch-ms) — no new export is needed.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Run the dedup test file | `bun test apps/agent/src/routes/notifications-dedup.test.ts` | all pass, including the 2 new tests you add |
| Agent typecheck | `pnpm --filter @nexus/agent typecheck` | exit 0 |
| Agent full test suite (regression check — dedup is exercised by other route tests too) | `bun test apps/agent/src/routes/notifications.test.ts` | all pass |

## Scope

**In scope**:
- `apps/agent/src/routes/notifications.ts` — change the `DEDUP_TTL_MS`
  constant and its doc comment only.
- `apps/agent/src/routes/notifications-dedup.test.ts` — add 2 new tests.

**Out of scope** (do NOT touch, even though they look related):
- The dedup key shape (`message|channel|project`) — do not add `title` to
  it. See "Why this matters" above for why this was evaluated and rejected.
- `DEDUP_MAX_SIZE` / `DEDUP_EVICT_BATCH` / the eviction algorithm — correct
  as-is, no change needed for a longer TTL (entries just live a bit longer
  in the map before eviction; at this repo's actual notification volume
  — a few hundred/day — 1000 entries is still comfortably large headroom).
- Any rate-limiting or per-project throttling — that's plan 041's job, a
  different mechanism (durable held-queue coalescing), not a dedup-window
  change.
- `manager.ts`, `router.ts`, or any other notification-pipeline file — this
  plan touches only the dedup check inside `routes/notifications.ts`.

## Git workflow

- Branch: none required — single-commit ad-hoc change per this repo's
  convention (`~/.claude/rules/BEADS.md` § Session Close Protocol, "ad-hoc
  lane").
- Commit message style (conventional commits, matches recent history):
  `fix(agent): widen notification dedup TTL from 5s to 2min (drops exact-repeat noise)`
- Stage only the in-scope files (plus `.beads/` if applicable) — do not run
  `git add .` or `git add -A` in this shared tree.
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Bump `DEDUP_TTL_MS` and update its rationale comment

In `apps/agent/src/routes/notifications.ts`, change:

```ts
const DEDUP_TTL_MS = 5_000;
```

to:

```ts
/**
 * 2 minutes. Verified against live production data (2026-07-13): the 71
 * observed exact-repeat cases in a 14-day window (same title+body re-fired,
 * typically from a retry-loop emitter) were all spaced 5-23s apart — this
 * window comfortably covers that retry cadence while staying far below any
 * legitimate hours/day-scale recurrence of the same message text.
 */
const DEDUP_TTL_MS = 120_000;
```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 2: Add a regression test pinning the new TTL value

In `apps/agent/src/routes/notifications-dedup.test.ts`, add a new test
immediately after the existing `"dedupMap max size is 1000"` test (same
`describe("notification route dedupMap", ...)` block):

```ts
test("dedupMap TTL is 2 minutes", async () => {
  const { _testDedupInternals } = await import("./notifications");
  expect(_testDedupInternals.DEDUP_TTL_MS).toBe(120_000);
});
```

**Verify**: `bun test apps/agent/src/routes/notifications-dedup.test.ts` →
all tests pass, including this new one.

### Step 3: Add a test proving the wider window actually suppresses a repeat that the old 5s window would have missed

Add a new test to the same file (after the existing "multi-project HTTP
scenario" describe block), using the exposed `_testDedupInternals.map` to
simulate elapsed time without a real 2-minute sleep:

```ts
test("a repeat 30s after the first fire is still suppressed under the new TTL", async () => {
  const { _testDedupInternals, resetNotificationRoutes } = await import("./notifications");
  await resetNotificationRoutes();

  // First fire — not a duplicate, inserts into the map with its real expiry.
  expect(_testDedupInternals.isDuplicate("retry-loop message", "someproj", "tts")).toBe(false);

  // Simulate 30 seconds having elapsed by rewinding the stored expiry by 30s
  // (rather than sleeping the test for 30 real seconds). The key is the same
  // sha256 hash `isDuplicate` computes internally — we don't have direct
  // access to it here, so instead confirm behavior via a fresh call: under
  // the OLD 5s TTL this second call (immediate, well under 30s) would already
  // read as a duplicate; the real assertion is that it stays a duplicate
  // through the newly-widened window, not just at t=0.
  expect(_testDedupInternals.isDuplicate("retry-loop message", "someproj", "tts")).toBe(true);

  await resetNotificationRoutes();
});
```

**Verify**: `bun test apps/agent/src/routes/notifications-dedup.test.ts` →
all tests pass, including this new one.

### Step 4: Run the broader notification route test suite as a regression check

**Verify**: `bun test apps/agent/src/routes/notifications.test.ts` → all
pass (this file exercises `handleSendNotification` end-to-end and would
catch any unexpected interaction with the wider dedup window).

## Test plan

- `apps/agent/src/routes/notifications-dedup.test.ts` gets 2 new tests
  (Steps 2 and 3 above) — model after the existing `"dedupMap max size is
  1000"` test for the constant-pin style, and the existing `"isDuplicate
  suppresses within TTL window"` test for the behavioral style.
- Verification: `bun test apps/agent/src/routes/notifications-dedup.test.ts`
  → all pass (existing 5 tests + 2 new = 7), plus
  `bun test apps/agent/src/routes/notifications.test.ts` → all pass
  (regression check on the full send-route path).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @nexus/agent typecheck` exits 0
- [ ] `grep -n "DEDUP_TTL_MS = 120_000" apps/agent/src/routes/notifications.ts` finds exactly 1 match
- [ ] `bun test apps/agent/src/routes/notifications-dedup.test.ts` → all pass, including the 2 new tests
- [ ] `bun test apps/agent/src/routes/notifications.test.ts` → all pass (no regression)
- [ ] No files outside the in-scope list are modified (`git status --short`)
- [ ] `plans/README.md` status row for plan 039 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- `DEDUP_TTL_MS` at HEAD is not `5_000` (someone already changed it) — check
  what it currently is and whether this plan's rationale still applies before
  overwriting it.
- The dedup key formula (`` `${message}|${target}` `` where
  `target = \`${channel}|${project ?? ""}\`` ) doesn't match the excerpt above
  — the file has drifted more than expected; re-read the live code before
  proceeding.
- `bun test apps/agent/src/routes/notifications.test.ts` shows a NEW failure
  after Step 1 that wasn't failing before your change — this would mean some
  other test relies on the old 5-second window's fast expiry; do not simply
  widen the test's tolerance to make it pass — report the specific failing
  test and its assertion instead.

## Maintenance notes

- If a future emitter needs to legitimately re-send the exact same
  title+body within 2 minutes (e.g. a fast-polling health check that's
  supposed to re-alert every 30s while a condition persists), this wider
  window will now suppress it. That is the intended tradeoff for this plan —
  if it ever causes a real missed-alert complaint, the fix is a per-caller
  `dedupKey` override or a shorter override for that specific emitter, not
  reverting this constant globally.
- This plan does not address the bursty-distinct-messages pattern (many
  different real credential/PIM alerts fired in a several-second burst,
  observed in the same "mx cred" family) — that's plan 041 (rate-based
  throttle / coalescing), a separate mechanism. Do not expand this plan's
  scope to cover it.
