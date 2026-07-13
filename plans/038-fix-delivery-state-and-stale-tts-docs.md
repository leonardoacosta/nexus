# Plan 038: Fix `deliveryState` never updating past insert + regenerate the stale Rust-era TTS pipeline docs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6796f8ab..HEAD -- apps/agent/src/notifications/buffer.ts docs/tts-pipeline.mmd .claude/commands/audit/notification-engine.md`
> Expected: no output (empty diff). If any of these files changed since this
> plan was written, compare the "Current state" excerpts below against the
> live file before proceeding; on a real mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug + docs
- **Planned at**: commit `6796f8ab`, 2026-07-13

## Why this matters

This bundles two small, unrelated-but-cheap fixes surfaced by a noise-reduction
audit of the notification/TTS system (`/improve` pass, 2026-07-13).

**Part A — `deliveryState` is dead on arrival.** The `notifications` table has
two parallel lifecycle columns: the legacy `status` (`queued`/`delivered`/
`expired`, written correctly) and the newer Swift-facing `deliveryState`
(`pending`/`delivered`/`failed`, added by `agent-payload-completeness` for the
dashboard). `deliveryState` is set once at insert time to its default
`"pending"` and then **never updated** — confirmed via exhaustive grep, the
only two functions that transition a notification's lifecycle
(`markNotificationDelivered`, `markNotificationExpired` in
`apps/agent/src/notifications/buffer.ts`) touch only `status`. Live production
data (queried 2026-07-13): 4458 of 4461 recent rows have `status='delivered'`
but `delivery_state='pending'`. Nothing in the Swift dashboard currently
renders this field (confirmed via repo-wide grep — zero references outside
`Notification.swift`'s decoder and test files), so this is not yet a visible
bug, but it is a landmine: the next feature built on `deliveryState` (a
delivered/failed badge, a filter) will ship broken on day one.

**Part B — stale architecture docs actively mislead.** `docs/tts-pipeline.mmd`
(and its rendered `.svg`/`.png`) and `.claude/commands/audit/notification-engine.md`
describe a Rust architecture (`crates/nexus-agent/src/notification_engine.rs`,
Rust CLIs `claude-notify`/`claude-emit`, a `spawn_config_watcher` hot-reload)
that **no longer exists in this repo** — `crates/` was confirmed absent during
this audit. The real pipeline is pure TypeScript under
`apps/agent/src/notifications/` and `apps/agent/src/routes/notifications*.ts`.
This already cost the auditing session time routing around the stale
diagram, and will cost the next person (human or agent) the same.

## Current state

### Part A files

- `apps/agent/src/notifications/buffer.ts` — DB-CRUD helpers over the
  `notifications` table. Current content of the two functions to fix
  (lines 43-57):

  ```ts
  /** Mark a notification as delivered. */
  export async function markNotificationDelivered(db: Db, id: string): Promise<void> {
    await db
      .update(notifications)
      .set({ status: "delivered", sentAt: new Date() })
      .where(eq(notifications.id, id));
  }

  /** Mark a notification as expired. */
  export async function markNotificationExpired(db: Db, id: string): Promise<void> {
    await db
      .update(notifications)
      .set({ status: "expired" })
      .where(eq(notifications.id, id));
  }
  ```

- `packages/core/src/types/notification.ts:19,33` defines the two enums this
  plan bridges:
  ```ts
  export type NotificationStatus = "queued" | "delivered" | "expired";
  // ...
  export type NotificationDeliveryState = "pending" | "delivered" | "failed";
  ```
  Mapping for this plan: `status="delivered"` -> `deliveryState="delivered"`;
  `status="expired"` -> `deliveryState="failed"` (an expired/dropped
  notification was never delivered — "failed" is the correct Swift-facing
  state, not the default "pending").

- `apps/agent/src/notifications/buffer.test.ts` — existing mock-DB test
  pattern to extend (lines 41-63 today):
  ```ts
  it("markNotificationDelivered sets status=delivered + sentAt", async () => {
    const where = mock(async () => {});
    const set = mock((_patch: unknown) => ({ where }));
    const update = mock(() => ({ set }));
    const db = { update } as unknown as import("@nexus/db").Db;

    await markNotificationDelivered(db, "n1");
    expect(set).toHaveBeenCalledTimes(1);
    const patch = set.mock.calls[0]![0] as { status: string; sentAt: Date };
    expect(patch.status).toBe("delivered");
    expect(patch.sentAt).toBeInstanceOf(Date);
  });

  it("markNotificationExpired sets status=expired", async () => {
    const where = mock(async () => {});
    const set = mock((_patch: unknown) => ({ where }));
    const update = mock(() => ({ set }));
    const db = { update } as unknown as import("@nexus/db").Db;

    await markNotificationExpired(db, "n1");
    const patch = set.mock.calls[0]![0] as { status: string };
    expect(patch.status).toBe("expired");
  });
  ```
  Both tests currently only assert on `status`/`sentAt` — extend them to also
  assert the `deliveryState` field on the same `patch` object (do not add new
  `it()` blocks for this — the patch object already captures every field
  passed to `.set()`, so add assertions inline).

### Part B files

- `docs/tts-pipeline.mmd` — 156-line mermaid flowchart. Its very first
  subgraph (`triggers`) and the `cli` subgraph describe Rust binaries
  (`claude-notify`, `claude-emit`) and a Unix socket at
  `/tmp/claude-notify.sock` that do not exist in this repo — those are the
  **CC-side** `~/.claude/scripts/lib/nx-send.sh` client (a different repo,
  `~/dev/cc`), not part of Nexus's own pipeline, and even that script no
  longer matches this description. The `receiver`/`pipeline`/`delivery`
  subgraphs describe a `ReceiverService`, `message_store`, and a `Rust`
  `notification_engine.rs` implementation that is gone.
- `docs/tts-pipeline.svg`, `docs/tts-pipeline.png` — rendered outputs of the
  same stale `.mmd`.
- `.claude/commands/audit/notification-engine.md` — an audit command whose
  Phase 1 file list (lines 38-47) names `crates/nexus-agent/src/notification_engine.rs`,
  `apps/agent/src/notifications/manager.ts`/`buffer.ts`/`router.ts`/
  `meeting-state.ts` — the last four DO still exist and are correct, but the
  Rust file does not, and the "Rust Notification Engine" table (lines 49-57)
  documents functions (`spawn_config_watcher`, `speak_from_socket`,
  `announce_errors`) that have no TypeScript equivalent in this repo anymore.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Confirm `crates/` really doesn't exist (sanity check before touching docs) | `ls crates/ 2>&1` | `No such file or directory` |
| Agent unit tests | `bun test apps/agent/src/notifications/buffer.test.ts` | all pass, including the 2 extended tests |
| Agent typecheck | `pnpm --filter @nexus/agent typecheck` | exit 0 |
| Render the regenerated mermaid diagram | `PUPPETEER_EXECUTABLE_PATH=$(ls -d ~/.cache/puppeteer/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null \| head -1) mmdc -i docs/tts-pipeline.mmd -o docs/tts-pipeline.svg -b transparent` | exit 0, `docs/tts-pipeline.svg` updated (newer mtime) |
| Confirm no remaining Rust references in the regenerated docs | `grep -rn "notification_engine.rs\|claude-notify\|claude-emit\|crates/nexus-agent" docs/tts-pipeline.mmd .claude/commands/audit/notification-engine.md` | no output |

If `mmdc`/puppeteer is unavailable on the executing machine, skip the render
step and note it — the `.mmd` source edit is the load-bearing fix; the `.svg`/
`.png` are derived artifacts that a later pass (or CI) can regenerate.

## Scope

**In scope**:
- `apps/agent/src/notifications/buffer.ts`
- `apps/agent/src/notifications/buffer.test.ts`
- `docs/tts-pipeline.mmd`
- `docs/tts-pipeline.svg`, `docs/tts-pipeline.png` (regenerated, not hand-edited)
- `.claude/commands/audit/notification-engine.md`

**Out of scope** (do NOT touch, even though they look related):
- `.claude/audit/memory/notification-engine-memory.md` — the audit-memory
  bootstrap file; it has no incorrect architectural claims (it's mostly
  empty placeholders), leave it as-is.
- Any other file under `apps/agent/src/notifications/` — this plan only
  touches the two lifecycle-transition functions in `buffer.ts`, not the
  callers (`manager.ts`) — they already pass the row through unchanged and
  need no edits.
- `packages/core/src/types/notification.ts` — the enum types are already
  correct; this plan only makes the code honor them.
- The Swift side (`apps/swift/**`) — no Swift file reads `deliveryState`
  today (confirmed by grep in the audit), so there is nothing to update there.
  Do not add Swift UI for this field — that is a separate, larger follow-up
  (see Maintenance notes).

## Git workflow

- Branch: none required — single-commit ad-hoc change per this repo's
  convention (`~/.claude/rules/BEADS.md` § Session Close Protocol, "ad-hoc
  lane").
- Commit message style (conventional commits, matches recent history — see
  `git log --oneline -5`): something like
  `fix(agent): write deliveryState on notification lifecycle transitions; regen stale TTS pipeline docs`
- Stage only the in-scope files (plus `.beads/` if your workflow updates
  beads) — do not run `git add .` or `git add -A` in this shared tree.
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Write `deliveryState` alongside `status` in `markNotificationDelivered`

In `apps/agent/src/notifications/buffer.ts`, change:

```ts
export async function markNotificationDelivered(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "delivered", sentAt: new Date() })
    .where(eq(notifications.id, id));
}
```

to:

```ts
export async function markNotificationDelivered(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "delivered", deliveryState: "delivered", sentAt: new Date() })
    .where(eq(notifications.id, id));
}
```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0 (confirms
`deliveryState` is a valid column key on the `notifications` update shape).

### Step 2: Write `deliveryState` alongside `status` in `markNotificationExpired`

In the same file, change:

```ts
export async function markNotificationExpired(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "expired" })
    .where(eq(notifications.id, id));
}
```

to:

```ts
export async function markNotificationExpired(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "expired", deliveryState: "failed" })
    .where(eq(notifications.id, id));
}
```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 3: Extend the two existing tests to assert `deliveryState`

In `apps/agent/src/notifications/buffer.test.ts`, extend the two test bodies
(do not add new `it()` blocks):

```ts
it("markNotificationDelivered sets status=delivered + sentAt", async () => {
  const where = mock(async () => {});
  const set = mock((_patch: unknown) => ({ where }));
  const update = mock(() => ({ set }));
  const db = { update } as unknown as import("@nexus/db").Db;

  await markNotificationDelivered(db, "n1");
  expect(set).toHaveBeenCalledTimes(1);
  const patch = set.mock.calls[0]![0] as { status: string; deliveryState: string; sentAt: Date };
  expect(patch.status).toBe("delivered");
  expect(patch.deliveryState).toBe("delivered");
  expect(patch.sentAt).toBeInstanceOf(Date);
});

it("markNotificationExpired sets status=expired", async () => {
  const where = mock(async () => {});
  const set = mock((_patch: unknown) => ({ where }));
  const update = mock(() => ({ set }));
  const db = { update } as unknown as import("@nexus/db").Db;

  await markNotificationExpired(db, "n1");
  const patch = set.mock.calls[0]![0] as { status: string; deliveryState: string };
  expect(patch.status).toBe("expired");
  expect(patch.deliveryState).toBe("failed");
});
```

**Verify**: `bun test apps/agent/src/notifications/buffer.test.ts` → all 4
tests pass (the 2 you extended + `insertNotification` + `getNotificationById`
unchanged).

### Step 4: Rewrite `docs/tts-pipeline.mmd` to describe the real TypeScript pipeline

Replace the entire file. The real pipeline (verified by this audit) is:

1. **Emission**: any caller (CC hook lifecycle via `hook-trigger.ts`, or an
   external client like the CC-side `nx_notify` script in a separate repo)
   POSTs to `POST /notifications/send` (`apps/agent/src/routes/notifications.ts`).
2. **Validation + 5s exact-duplicate dedup**: `isDuplicate()` in the same
   file, keyed on `sha256(body|channel|project)`, `DEDUP_TTL_MS = 5000`.
3. **Insert**: `NotificationManager.send()` (`apps/agent/src/notifications/manager.ts`)
   always inserts the row into the `notifications` table first
   (`insertNotification`, `buffer.ts`).
4. **Presence-aware routing** (when `notification_settings.presence_aware_routing`
   is on and the presence vector has at least one known field):
   `decidePresenceRoute()` (`router.ts`) evaluates `evaluateRules()`
   (`rules-engine.ts`, priority-ordered Rules 1-4 + terminal fallback) against
   the current `PresenceVector` (`presence-context.ts`) — deciding
   banner/tts/hold/deliverTo.
5. **Meeting-hold coalescing**: when Rule 2 matches (Mac present + in
   meeting), the notification is persisted to `presence_holds`
   (`held-queue.ts`, durable — survives agent restart) and later flushed as
   ONE coalesced summary (`manager.flushHeldBatch()`).
6. **Legacy fallback**: when presence routing is off, or the vector is
   all-unknown (headless/background session, no Mac/phone signal at all),
   `decidePresenceRoute()` returns `null` and the manager falls back to a
   simple `meetingState.active` buffer/drop check (`manager.ts`'s legacy
   branch) — this path has no time-of-day awareness (see plans 041/042 for
   the noise implications).
7. **Delivery**: `routeNotificationParallel()` (`router.ts`) fans out to the
   channel handlers — `tts` (ElevenLabs synthesis via
   `notifications/audio-store.ts`, or the Mac-side `NexusShared` client
   depending on deployment), `desktop`, `telegram`.
8. **Lifecycle**: on any channel success, `markNotificationDelivered()`
   (`buffer.ts`) stamps the row and `lifecycleBus.emit("NotificationFired", ...)`
   fires for SSE subscribers (Swift dashboards, statusline).

Write a new mermaid `flowchart TB` capturing this real flow (emission ->
dedup -> insert -> presence-aware routing / legacy fallback -> hold-or-deliver
-> channel fan-out -> lifecycle event), using the same dark-theme `%%{init:...}%%`
header style as the current file (lines 1) for visual consistency with other
repo diagrams. Keep it to the real components only — do not invent detail
beyond what's listed above; if uncertain about a specific edge, omit it rather
than guess (this is a documentation accuracy fix, not a new design).

**Verify**: `grep -n "notification_engine.rs\|claude-notify\|claude-emit\|crates/nexus-agent\|ReceiverService" docs/tts-pipeline.mmd` → no output.

### Step 5: Regenerate the rendered diagram outputs

**Verify**:
```bash
PUPPETEER_EXECUTABLE_PATH=$(ls -d ~/.cache/puppeteer/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -1) \
  mmdc -i docs/tts-pipeline.mmd -o docs/tts-pipeline.svg -b transparent
PUPPETEER_EXECUTABLE_PATH=$(ls -d ~/.cache/puppeteer/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -1) \
  mmdc -i docs/tts-pipeline.mmd -o docs/tts-pipeline.png -b transparent
```
→ exit 0, both files updated. If `mmdc`/puppeteer is unavailable, skip this
step, leave the old `.svg`/`.png` in place, and note in your final report
that the rendered outputs are stale relative to the corrected `.mmd` source —
do not treat this as a plan failure.

### Step 6: Rewrite the Rust references in the audit command

In `.claude/commands/audit/notification-engine.md`:
- Delete the "Rust Notification Engine (`notification_engine.rs`)" table
  (lines 49-57) and its "Focus on: ... config reload atomicity, meeting state
  transitions" Task prompt reference to `crates/nexus-agent/src/notification_engine.rs`
  (line 39-46) — there is no Rust component left to audit.
- In the Phase 1 file list (lines 34-46), drop the Rust path and replace the
  remaining TypeScript file list with the accurate current set: `manager.ts`,
  `buffer.ts`, `router.ts`, `meeting-state.ts`, `rules-engine.ts`,
  `hook-rules.ts`, `hook-trigger.ts`, `held-queue.ts`, `presence-context.ts`,
  `routes/notifications.ts`, `routes/notification-settings.ts`.
- Update the "TypeScript Notifications" table (lines 59-66) if any of its
  "What to check" questions reference removed concepts (e.g. an in-memory
  buffer overflow question that no longer applies since `buffer.ts`'s
  in-memory ring was removed by `context-aware-routing` — see `buffer.ts`'s
  own header comment) — replace with a question about the durable
  `held-queue.ts` / `presence_holds` table instead.
- Do not rewrite Phase 2/3 (Reliability/Observability) or the Evaluation
  Criteria — those sections describe checks that still make sense generically
  and are out of this plan's scope (docs-accuracy only, not a full command
  rewrite).

**Verify**: `grep -n "notification_engine.rs\|claude-notify\|claude-emit\|crates/nexus-agent" .claude/commands/audit/notification-engine.md` → no output.

## Test plan

- Extend the 2 existing `buffer.test.ts` tests (Step 3) — no new test file
  needed; this is a pure behavior addition to already-tested functions.
- No test coverage is expected or needed for the docs changes (Steps 4-6) —
  verify by grep only, per the Commands table above.
- Verification: `bun test apps/agent/src/notifications/buffer.test.ts` →
  4 pass, 0 fail.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @nexus/agent typecheck` exits 0
- [ ] `bun test apps/agent/src/notifications/buffer.test.ts` → 4 pass, 0 fail
- [ ] `grep -n "deliveryState: \"delivered\"" apps/agent/src/notifications/buffer.ts` finds exactly 1 match (in `markNotificationDelivered`)
- [ ] `grep -n "deliveryState: \"failed\"" apps/agent/src/notifications/buffer.ts` finds exactly 1 match (in `markNotificationExpired`)
- [ ] `grep -rn "notification_engine.rs\|claude-notify\|claude-emit\|crates/nexus-agent" docs/tts-pipeline.mmd .claude/commands/audit/notification-engine.md` returns no matches
- [ ] No files outside the in-scope list are modified (`git status --short`)
- [ ] `plans/README.md` status row for plan 038 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- `buffer.ts`'s `markNotificationDelivered`/`markNotificationExpired` no
  longer match the "Current state" excerpt above (someone else already
  touched the lifecycle transitions) — re-check whether `deliveryState` is
  already being written before applying this plan's edit a second time.
- `pnpm --filter @nexus/agent typecheck` fails after Steps 1-2 with an error
  about `deliveryState` not being a valid key — this would mean the
  generated Drizzle row type doesn't match this plan's assumption; stop and
  report the exact error rather than guessing a workaround.
- The `bun test` run in Step 3 shows failures in tests OTHER than the two you
  edited — that signals your edit had a wider effect than intended.
- `mmdc` is present but the render command in Step 5 exits non-zero for a
  reason other than "puppeteer path not found" (e.g. a real mermaid syntax
  error in your rewritten `.mmd`) — fix the syntax once; if it still fails,
  stop and report the exact mmdc error output.

## Maintenance notes

- This plan fixes the **data layer** for `deliveryState`; it does not add any
  Swift UI to display it. If a future change wants a "delivered/failed" badge
  in `NotificationsView.swift`, that's a separate, larger follow-up — the
  data will now be correct for it to consume.
- The rewritten `docs/tts-pipeline.mmd` should be kept in sync the next time
  the notification pipeline changes shape (e.g. if plans 040/041/042 from
  this same audit wave land — the quiet-hours gate and rate-throttle they add
  are new decision points worth adding to the diagram in a later docs pass,
  not retroactively inserted here since they don't exist yet at plan-authoring
  time).
- If a Rust component is ever reintroduced to this repo, re-verify this
  diagram and the audit command against it — right now both correctly
  describe zero Rust involvement.
