# Plan 041: Downgrade repeat TTS notifications to silent desktop when a project exceeds a rate threshold

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6796f8ab..HEAD -- apps/agent/src/notifications/manager.ts apps/agent/src/notifications/buffer.ts apps/agent/src/routes/notifications.ts apps/agent/src/routes/notification-settings.ts packages/db/src/schema/notificationSettings.ts`
> Expected: no output (empty diff). If any of these files changed since this
> plan was written, compare the "Current state" excerpts below against the
> live file before proceeding; on a real mismatch, treat it as a STOP
> condition.
>
> **Sequencing note**: this plan and plan 042 (quiet-hours gate) both touch
> `apps/agent/src/notifications/manager.ts`'s `send()` method, in different
> regions. They are logically independent (no dependency either direction),
> but should NOT be executed concurrently by two different engineers in
> parallel worktrees without merging carefully — do one, then the other.
> Recommended order: this plan (041) first, then 042.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (touches the core `send()` path; mitigated by defaulting the
  feature to only affect non-critical, project-scoped TTS notifications, and
  by the settings-driven enable/disable toggle)
- **Depends on**: none
- **Category**: bug (noise reduction)
- **Planned at**: commit `6796f8ab`, 2026-07-13

## Why this matters

A noise-reduction audit of the notification/TTS system (`/improve` pass,
2026-07-13) found that **no volume/rate-based throttle exists anywhere
outside explicit meeting mode**. The only coalescing mechanism
(`held-queue.ts`) fires solely on a meeting-hold decision (Rule 2 in
`rules-engine.ts`). This was verified against live production data: a single
autonomous project (`🔗 Wholesale Architecture`) fired 1,112 distinct TTS
notifications in a 14-day window (~79/day) — each one delivered
individually, no digesting, no rate limit. A burst check on the same data
found up to 21 notifications firing within a single 1-minute window.

This plan adds a **project-scoped rate throttle**: when a project has
already fired `maxPerWindow` TTS notifications within a rolling
`windowMinutes` window, subsequent non-critical TTS notifications for that
same project are delivered as a **silent desktop notification instead of
TTS** — the full notification (title, body, history row) is preserved
exactly as before, only the audio channel is suppressed. Critical-priority
notifications (`priority: "high"`, used by `hook-rules.ts` for
crash/permission-request/hook-failure/api-error — see
`apps/agent/src/notifications/hook-rules.ts:225,259,278,318`) are **never**
downgraded by this mechanism, regardless of rate.

**Design choice — why "downgrade channel" instead of "hold + coalesce into
one digest"**: the existing `held-queue.ts` + `manager.flushHeldBatch()`
coalescing machinery (used by Rule 2's meeting-hold) has a flush-trigger path
this audit did not fully trace (holds created outside the explicit
`/meeting/end` call rely on a per-hold `scheduleFlush` timer whose exact
interaction with `flushHeldBatch`'s summary-generation is not confirmed for
the non-meeting case). Rather than guess at that interaction and risk a
notification silently never being delivered, this plan uses a simpler,
independently-correct mechanism: a live `COUNT(*)` query against the
`notifications` table itself (no new state, survives restarts naturally) and
a channel swap on the SAME insert path every other notification already
takes. This is a smaller, lower-risk change that directly achieves the
stated goal (stop audio-spamming for repeat pings) without depending on
uncertain existing machinery. A future richer "N updates" coalesced-summary
version (mirroring Rule 2's UX) is a reasonable follow-up once the held-queue
flush-trigger semantics are independently confirmed — not built here.

## Current state

### Schema

- `packages/db/src/schema/notificationSettings.ts` — single-row sentinel
  table. Current full column list (lines 22-48):
  ```ts
  export const notificationSettings = pgTable("notification_settings", {
    id: integer("id").primaryKey().default(1),
    ttsEnabled: boolean("tts_enabled").notNull().default(true),
    bannerEnabled: boolean("banner_enabled").notNull().default(true),
    duckingMode: text("ducking_mode")
      .$type<"full" | "half" | "mute">()
      .notNull()
      .default("full"),
    presenceAwareRouting: boolean("presence_aware_routing")
      .notNull()
      .default(false),
    unknownNoncriticalMode: text("unknown_noncritical_mode")
      .$type<"fail-safe" | "fail-open">()
      .notNull()
      .default("fail-safe"),
    unknownCriticalMode: text("unknown_critical_mode")
      .$type<"fail-open" | "fail-safe">()
      .notNull()
      .default("fail-open"),
    bedtimeSources: text("bedtime_sources")
      .$type<"hk" | "focus" | "either" | "both">()
      .notNull()
      .default("either"),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  });
  ```
  This plan adds 3 columns: `rateThrottleEnabled` (boolean, default `true`),
  `rateThrottleMaxPerWindow` (integer, default `5`),
  `rateThrottleWindowMinutes` (integer, default `5`). Defaults were chosen to
  directly address the empirical burst pattern (up to 21/minute observed)
  while staying generous enough not to suppress normal, spread-out activity
  (a project firing 5 TTS notifications inside any 5-minute window is
  already unusual outside a burst).
- Migration precedent: `packages/db/drizzle/0044_silent_mesmero.sql` (the
  migration that added `bedtime_sources`) is a single-statement
  `ALTER TABLE ... ADD COLUMN` — this plan's migration follows the same
  shape, auto-generated via `db:generate` (do not hand-write the SQL file or
  its filename).

### `notification-settings.ts` route

- `apps/agent/src/routes/notification-settings.ts` — the exact pattern to
  extend for each of the 3 new fields (using `bedtime_sources` as the
  template, lines 36-45, 260-269, 298-299):
  ```ts
  // ALLOWED_KEYS (line 29-38) — add 3 new entries to this Set
  const ALLOWED_KEYS = new Set([
    "tts_enabled",
    "banner_enabled",
    "ducking_mode",
    "presence_aware_routing",
    "unknown_noncritical_mode",
    "unknown_critical_mode",
    "bedtime_sources",
  ]);

  // Per-field validation block (bedtime_sources example, lines 260-269):
  if ("bedtime_sources" in patch) {
    const m = patch.bedtime_sources;
    if (typeof m !== "string" || !BEDTIME_SOURCES.has(m)) {
      return jsonResponse(
        { error: "bedtime_sources must be one of: hk, focus, either, both" },
        400,
      );
    }
    update.bedtimeSources = m as BedtimeSources;
  }

  // "changed" no-op check (lines 288-299) — bedtime_sources is the last
  // `||` clause today; add 3 more clauses in the same style.
  ```
  `SettingsResponse`/`SettingsRow` interfaces (lines 47-69) and the
  `toResponse()` mapper (lines 78-90) also need the 3 new fields added,
  following the exact same field-by-field shape as every existing entry.

### `buffer.ts` (new DB helper)

- `apps/agent/src/notifications/buffer.ts` — current imports (line 20):
  ```ts
  import { eq, asc } from "drizzle-orm";
  ```
  This plan adds a new exported function, `countRecentNotifications`,
  requiring `and`, `gte`, `isNull`, and `sql` added to that import.

### `manager.ts`

- `apps/agent/src/notifications/manager.ts` — the `PresenceWiring` /
  `CrossMachineWiring` interfaces (lines 78-119) are the established
  dependency-injection pattern this plan's new `RateThrottleWiring`
  interface follows. The constructor (lines 127-137):
  ```ts
  export class NotificationManager {
    private meetingState: MeetingState;
    private db: Db;
    private presence: PresenceWiring | null;
    private crossMachine: CrossMachineWiring | null;

    constructor(
      db: Db,
      meetingState?: MeetingState,
      presence?: PresenceWiring,
      crossMachine?: CrossMachineWiring,
    ) {
      this.db = db;
      this.meetingState = meetingState ?? new MeetingState();
      this.presence = presence ?? null;
      this.crossMachine = crossMachine ?? null;
    }
    ...
  ```
  `send()`'s row construction (lines 154-183) is unchanged; this plan inserts
  new logic immediately after the row object is built and BEFORE
  `await insertNotification(this.db, row);` (line 183) — so the persisted
  `channel` column reflects the downgrade decision truthfully, matching the
  existing convention in `flushHeldBatch()` (lines 345-357) where `channel:
  silent ? "desktop" : "tts"` is decided before that function's own insert.

### `routes/notifications.ts` (wiring at boot)

- `apps/agent/src/routes/notifications.ts:108-171` — `readPresenceAwareRouting`
  and `initNotificationRoutes` are the pattern this plan's new
  `readRateThrottleSettings` function and its wiring into the
  `NotificationManager` constructor call follow exactly.

### Test pattern to follow

- `apps/agent/src/notifications/manager-presence.test.ts:1-90` — the
  established lightweight manager-unit-test idiom (no live PG, no HTTP
  stubbing): `installNexusDbMock()` + `installCoreNodeMock()` +
  `installBufferMock()`, `stubDb = {} as never`, a hand-rolled
  `makeHeldQueueStub()`-style fake for injected wiring, and
  `makeSendInput(id)` for constructing a minimal send() argument. This
  plan's tests for the new `RateThrottleWiring` follow the same shape (a
  `makeRateThrottleStub()` helper instead of `makeHeldQueueStub()`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate the migration after editing the schema | `pnpm --filter @nexus/db db:generate` | new file appears under `packages/db/drizzle/`, single `ALTER TABLE "notification_settings" ADD COLUMN ...` x3 statements |
| DB package typecheck | `pnpm --filter @nexus/db typecheck` | exit 0 |
| Agent typecheck | `pnpm --filter @nexus/agent typecheck` | exit 0 |
| Run the manager rate-throttle tests | `bun test apps/agent/src/notifications/manager-rate-throttle.test.ts` | all pass |
| Run the buffer tests (new helper) | `bun test apps/agent/src/notifications/buffer.test.ts` | all pass |
| Run the notification-settings route tests | `bun test apps/agent/src/routes/notification-settings.test.ts` | all pass |
| Full agent regression | `bun test apps/agent/src/notifications/` | all pass |

## Scope

**In scope**:
- `packages/db/src/schema/notificationSettings.ts` — add 3 columns.
- `packages/db/drizzle/*.sql` — new auto-generated migration (do not hand-author).
- `apps/agent/src/routes/notification-settings.ts` — extend allow-list, types, validation, response mapping.
- `apps/agent/src/routes/notification-settings.test.ts` — extend tests for the 3 new fields.
- `apps/agent/src/notifications/buffer.ts` — add `countRecentNotifications`.
- `apps/agent/src/notifications/buffer.test.ts` — add tests for the new function.
- `apps/agent/src/notifications/manager.ts` — add `RateThrottleWiring` interface, constructor param, and the throttle check in `send()`.
- `apps/agent/src/notifications/manager-rate-throttle.test.ts` (new file) — unit tests for the throttle decision.
- `apps/agent/src/routes/notifications.ts` — add `readRateThrottleSettings` and wire it into `initNotificationRoutes`.

**Out of scope** (do NOT touch, even though they look related):
- `held-queue.ts`, `rules-engine.ts`, `router.ts`'s `decidePresenceRoute` —
  this plan's throttle check runs BEFORE the presence-aware routing block
  and does not modify it. Do not attempt to route the throttled notification
  through the held-queue/meeting-hold machinery — see "Why this matters"
  above for why that was deliberately avoided.
- The dedup TTL (`routes/notifications.ts`'s `DEDUP_TTL_MS`) — that's plan
  039, already landed or landing independently; do not touch it here.
- The quiet-hours gate — that's plan 042, a separate change to a different
  region of `manager.ts`'s `send()` (see the Sequencing note at the top of
  this plan).
- Swift dashboard UI for the new settings fields — a settings toggle UI is a
  separate follow-up; this plan only needs the fields to exist and be
  patchable via the existing `PATCH /notifications/settings` route (which
  the Mac listener and any future UI already know how to call generically).

## Git workflow

- Branch: none required — single-commit ad-hoc change per this repo's
  convention (`~/.claude/rules/BEADS.md` § Session Close Protocol, "ad-hoc
  lane"). Given the size (L effort, migration + 4 source files), a
  multi-commit sequence within the same ad-hoc push is acceptable — commit
  per logical step (schema+migration, then settings route, then buffer
  helper, then manager wiring) — but push once at the end per the
  single-push convention.
- Commit message style (conventional commits): e.g.
  `feat(agent): add project-scoped rate throttle for repeat TTS notifications`
- Stage only the in-scope files (plus `.beads/` if applicable) — do not run
  `git add .` or `git add -A` in this shared tree.
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Add the 3 new settings columns to the schema

In `packages/db/src/schema/notificationSettings.ts`, add after
`bedtimeSources` and before `updatedAt`:

```ts
  /**
   * Project-scoped TTS rate throttle (noise-reduction audit, 2026-07-13).
   * When a project has fired `rateThrottleMaxPerWindow` or more TTS
   * notifications within the trailing `rateThrottleWindowMinutes`, further
   * non-critical (priority != "high") TTS notifications for that project are
   * delivered as a silent desktop notification instead — see
   * NotificationManager.send() in apps/agent/src/notifications/manager.ts.
   */
  rateThrottleEnabled: boolean("rate_throttle_enabled").notNull().default(true),
  rateThrottleMaxPerWindow: integer("rate_throttle_max_per_window")
    .notNull()
    .default(5),
  rateThrottleWindowMinutes: integer("rate_throttle_window_minutes")
    .notNull()
    .default(5),
```

Note: `integer` is already imported in this file (used by `id: integer("id")...`)
— no new import needed.

**Verify**: `pnpm --filter @nexus/db typecheck` → exit 0.

### Step 2: Generate the migration

**Verify**: `pnpm --filter @nexus/db db:generate` → a new file appears under
`packages/db/drizzle/` containing exactly 3 `ALTER TABLE
"notification_settings" ADD COLUMN ...` statements (one per new column),
matching the single-statement shape of `packages/db/drizzle/0044_silent_mesmero.sql`.
Do not hand-edit the generated file or its auto-assigned filename.

### Step 3: Extend the `notification-settings.ts` route

In `apps/agent/src/routes/notification-settings.ts`:

1. Add to `ALLOWED_KEYS` (after `"bedtime_sources"`):
   ```ts
   "rate_throttle_enabled",
   "rate_throttle_max_per_window",
   "rate_throttle_window_minutes",
   ```
2. Add to the `SettingsResponse` interface (after `bedtime_sources: BedtimeSources;`):
   ```ts
   rate_throttle_enabled: boolean;
   rate_throttle_max_per_window: number;
   rate_throttle_window_minutes: number;
   ```
3. Add to the `SettingsRow` interface (after `bedtimeSources: BedtimeSources;`):
   ```ts
   rateThrottleEnabled: boolean;
   rateThrottleMaxPerWindow: number;
   rateThrottleWindowMinutes: number;
   ```
4. Add to `toResponse()` (after `bedtime_sources: row.bedtimeSources,`):
   ```ts
   rate_throttle_enabled: row.rateThrottleEnabled,
   rate_throttle_max_per_window: row.rateThrottleMaxPerWindow,
   rate_throttle_window_minutes: row.rateThrottleWindowMinutes,
   ```
5. Add 3 new per-field validation blocks in `handlePatchNotificationSettings`
   (after the `bedtime_sources` block):
   ```ts
   if ("rate_throttle_enabled" in patch) {
     if (typeof patch.rate_throttle_enabled !== "boolean") {
       return jsonResponse({ error: "rate_throttle_enabled must be a boolean" }, 400);
     }
     update.rateThrottleEnabled = patch.rate_throttle_enabled;
   }

   if ("rate_throttle_max_per_window" in patch) {
     const v = patch.rate_throttle_max_per_window;
     if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
       return jsonResponse(
         { error: "rate_throttle_max_per_window must be a positive integer" },
         400,
       );
     }
     update.rateThrottleMaxPerWindow = v;
   }

   if ("rate_throttle_window_minutes" in patch) {
     const v = patch.rate_throttle_window_minutes;
     if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
       return jsonResponse(
         { error: "rate_throttle_window_minutes must be a positive integer" },
         400,
       );
     }
     update.rateThrottleWindowMinutes = v;
   }
   ```
   Also add matching optional fields to the `update` object's inline type
   (the `Partial<{...}>` block just above the `tts_enabled` check).
6. Add 3 new clauses to the `changed` boolean expression (after the
   `bedtimeSources` clause):
   ```ts
   (update.rateThrottleEnabled !== undefined &&
     update.rateThrottleEnabled !== current.rateThrottleEnabled) ||
   (update.rateThrottleMaxPerWindow !== undefined &&
     update.rateThrottleMaxPerWindow !== current.rateThrottleMaxPerWindow) ||
   (update.rateThrottleWindowMinutes !== undefined &&
     update.rateThrottleWindowMinutes !== current.rateThrottleWindowMinutes);
   ```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 4: Extend the notification-settings route tests

In `apps/agent/src/routes/notification-settings.test.ts`, find the existing
tests for `bedtime_sources` (GET returns it, PATCH validates it, PATCH
persists it) and add 3 parallel tests for `rate_throttle_enabled` following
the exact same structure — GET includes the field with its default,
PATCH rejects a non-boolean/non-positive-integer value with 400, PATCH
persists a valid value and returns it in the response.

**Verify**: `bun test apps/agent/src/routes/notification-settings.test.ts` → all pass.

### Step 5: Add the `countRecentNotifications` helper to `buffer.ts`

In `apps/agent/src/notifications/buffer.ts`:

1. Change the import line:
   ```ts
   import { eq, asc } from "drizzle-orm";
   ```
   to:
   ```ts
   import { eq, asc, and, gte, isNull } from "drizzle-orm";
   ```
2. Add this new exported function (after `getNotificationById`):
   ```ts
   /**
    * Count notifications for a given (project, channel) pair created since
    * `since` — used by the rate-throttle in manager.ts (plan 041,
    * noise-reduction audit 2026-07-13). `project` is matched with `IS NULL`
    * when null, `= project` otherwise, mirroring the dedup key convention in
    * routes/notifications.ts.
    */
   export async function countRecentNotifications(
     db: Db,
     project: string | null,
     channel: string,
     since: Date,
   ): Promise<number> {
     const conditions = [
       eq(notifications.channel, channel),
       gte(notifications.createdAt, since),
       project === null
         ? isNull(notifications.project)
         : eq(notifications.project, project),
     ];
     const rows = await db
       .select({ count: sql<number>`COUNT(*)` })
       .from(notifications)
       .where(and(...conditions));
     return Number(rows[0]?.count ?? 0);
   }
   ```
   This also needs `sql` added to the import from `drizzle-orm` (combine
   with the change above: `import { eq, asc, and, gte, isNull, sql } from "drizzle-orm";`).

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 6: Add tests for `countRecentNotifications`

In `apps/agent/src/notifications/buffer.test.ts`, add a new test (mock-DB
style, matching the existing tests in this file):

```ts
it("countRecentNotifications issues a COUNT query scoped to project+channel+since", async () => {
  const where = mock(async () => [{ count: 3 }]);
  const from = mock(() => ({ where }));
  const select = mock(() => ({ from }));
  const db = { select } as unknown as import("@nexus/db").Db;

  const count = await countRecentNotifications(db, "nx", "tts", new Date());
  expect(select).toHaveBeenCalledTimes(1);
  expect(count).toBe(3);
});

it("countRecentNotifications handles a null project", async () => {
  const where = mock(async () => [{ count: 0 }]);
  const from = mock(() => ({ where }));
  const select = mock(() => ({ from }));
  const db = { select } as unknown as import("@nexus/db").Db;

  const count = await countRecentNotifications(db, null, "tts", new Date());
  expect(count).toBe(0);
});
```
Add `countRecentNotifications` to the file's existing import from `"./buffer"`.

**Verify**: `bun test apps/agent/src/notifications/buffer.test.ts` → all pass.

### Step 7: Add `RateThrottleWiring` to `manager.ts` and wire the throttle check

In `apps/agent/src/notifications/manager.ts`:

1. Add a new interface (after `CrossMachineWiring`):
   ```ts
   /**
    * Rate-throttle collaborator (noise-reduction audit, 2026-07-13, plan 041).
    * Strictly additive: when omitted, no throttling occurs (byte-identical to
    * today). When wired, `send()` downgrades a non-critical, project-scoped
    * `tts` notification to `desktop` once the project has fired
    * `maxPerWindow` TTS notifications within the last `windowMinutes`.
    */
   export interface RateThrottleWiring {
     /** Reads the live rate-throttle settings (from notification_settings). */
     settings: () => Promise<RateThrottleSettings> | RateThrottleSettings;
     /** Counts `channel` notifications for `project` created since `since`. */
     countRecent: (
       project: string,
       channel: string,
       since: Date,
     ) => Promise<number>;
   }

   export interface RateThrottleSettings {
     enabled: boolean;
     maxPerWindow: number;
     windowMinutes: number;
   }
   ```
2. Add a private field and constructor parameter:
   ```ts
   private rateThrottle: RateThrottleWiring | null;

   constructor(
     db: Db,
     meetingState?: MeetingState,
     presence?: PresenceWiring,
     crossMachine?: CrossMachineWiring,
     rateThrottle?: RateThrottleWiring,
   ) {
     this.db = db;
     this.meetingState = meetingState ?? new MeetingState();
     this.presence = presence ?? null;
     this.crossMachine = crossMachine ?? null;
     this.rateThrottle = rateThrottle ?? null;
   }
   ```
3. In `send()`, immediately after the `row` object is fully constructed
   (right after the closing `};` of the `row` literal, lines ~167-180) and
   BEFORE `await insertNotification(this.db, row);` (line 183), insert:
   ```ts
   // ── Rate-based throttle (noise-reduction, plan 041) ────────────────────
   // Applies uniformly regardless of presence-routing state — a burst of
   // same-project TTS pings shouldn't fire individually even when Leo is
   // sitting right at his desk (Rule 1 would otherwise deliver every one).
   // Critical-priority notifications (crash/permission/hook-failure/
   // api-error, priority:"high") are never downgraded. Project-less
   // notifications are never throttled (no meaningful family to rate-limit).
   if (row.channel === "tts" && row.priority !== "high" && row.project && this.rateThrottle) {
     const throttleSettings = await this.rateThrottle.settings();
     if (throttleSettings.enabled) {
       const since = new Date(Date.now() - throttleSettings.windowMinutes * 60_000);
       const recentCount = await this.rateThrottle.countRecent(row.project, "tts", since);
       if (recentCount >= throttleSettings.maxPerWindow) {
         logger.info(
           {
             id: row.id,
             project: row.project,
             recentCount,
             maxPerWindow: throttleSettings.maxPerWindow,
           },
           "notification TTS downgraded to desktop (rate-throttle)",
         );
         row.channel = "desktop";
       }
     }
   }

   ```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 8: Add `manager-rate-throttle.test.ts`

Create `apps/agent/src/notifications/manager-rate-throttle.test.ts`, modeled
directly on `manager-presence.test.ts`'s idiom (same shared-mock header:
`installNexusDbMock()`, `installCoreNodeMock()`, `installBufferMock()` in
`beforeAll`/`afterAll`, `stubDb = {} as never`, a `makeSendInput(id)` helper):

```ts
/**
 * Manager rate-throttle tests (noise-reduction audit 2026-07-13, plan 041).
 *
 * Covers: throttle disabled → no downgrade; under threshold → no downgrade;
 * at/over threshold → tts downgraded to desktop; priority:"high" is never
 * downgraded regardless of count; project-less notifications are never
 * throttled.
 */

import { describe, expect, it, mock, beforeAll, afterAll } from "bun:test";
import { installNexusDbMock } from "../testing/mock-nexus-db";
import { installCoreNodeMock } from "../testing/mock-core-node";
import { installBufferMock, type BufferMockHandle } from "./testing-mocks";

installNexusDbMock();
installCoreNodeMock();

let bufferMock: BufferMockHandle;
beforeAll(() => {
  bufferMock = installBufferMock();
});
afterAll(() => {
  bufferMock.restore();
});

mock.module("@sentry/node", () => ({
  captureException: mock(() => {}),
  addBreadcrumb: mock(() => {}),
  init: mock(() => {}),
}));

const { NotificationManager } = await import("./manager");

const stubDb = {} as never;

function makeRateThrottleStub(opts: {
  enabled: boolean;
  maxPerWindow: number;
  windowMinutes: number;
  recentCount: number;
}) {
  const countRecent = mock(async () => opts.recentCount);
  return {
    settings: mock(async () => ({
      enabled: opts.enabled,
      maxPerWindow: opts.maxPerWindow,
      windowMinutes: opts.windowMinutes,
    })),
    countRecent,
  };
}

function makeSendInput(id: string, overrides: Partial<{ priority: string; project: string | null }> = {}) {
  return {
    id,
    title: "progress ping",
    body: "17 of 19 done",
    channel: "tts",
    priority: overrides.priority ?? "normal",
    project: overrides.project === undefined ? "nx" : overrides.project,
    agentId: null,
    createdAt: new Date(),
  } as never;
}

describe("manager rate-throttle", () => {
  it("throttle disabled → no downgrade even over threshold", async () => {
    const throttle = makeRateThrottleStub({ enabled: false, maxPerWindow: 5, windowMinutes: 5, recentCount: 10 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-1"));
    expect(row.channel).toBe("tts");
  });

  it("under threshold → no downgrade", async () => {
    const throttle = makeRateThrottleStub({ enabled: true, maxPerWindow: 5, windowMinutes: 5, recentCount: 2 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-2"));
    expect(row.channel).toBe("tts");
  });

  it("at threshold → downgraded to desktop", async () => {
    const throttle = makeRateThrottleStub({ enabled: true, maxPerWindow: 5, windowMinutes: 5, recentCount: 5 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-3"));
    expect(row.channel).toBe("desktop");
  });

  it("priority:high is never downgraded, regardless of count", async () => {
    const throttle = makeRateThrottleStub({ enabled: true, maxPerWindow: 5, windowMinutes: 5, recentCount: 50 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-4", { priority: "high" }));
    expect(row.channel).toBe("tts");
    expect(throttle.countRecent).not.toHaveBeenCalled();
  });

  it("project-less notifications are never throttled", async () => {
    const throttle = makeRateThrottleStub({ enabled: true, maxPerWindow: 5, windowMinutes: 5, recentCount: 50 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-5", { project: null }));
    expect(row.channel).toBe("tts");
    expect(throttle.countRecent).not.toHaveBeenCalled();
  });

  it("no rateThrottle wiring at all → byte-identical legacy behavior", async () => {
    const manager = new NotificationManager(stubDb);
    const row = await manager.send(makeSendInput("t-6"));
    expect(row.channel).toBe("tts");
  });
});
```

**Verify**: `bun test apps/agent/src/notifications/manager-rate-throttle.test.ts` → all 6 tests pass.

### Step 9: Wire the settings reader into `initNotificationRoutes`

In `apps/agent/src/routes/notifications.ts`:

1. Add a new function (after `readPresenceAwareRouting`):
   ```ts
   /** Reads the live rate-throttle settings from notification_settings. */
   async function readRateThrottleSettings(
     db: Db,
   ): Promise<{ enabled: boolean; maxPerWindow: number; windowMinutes: number }> {
     try {
       const row = await db.query.notificationSettings.findFirst({
         where: eq(notificationSettings.id, 1),
       });
       return {
         enabled: row?.rateThrottleEnabled ?? true,
         maxPerWindow: row?.rateThrottleMaxPerWindow ?? 5,
         windowMinutes: row?.rateThrottleWindowMinutes ?? 5,
       };
     } catch (err) {
       log.warn(
         { err: err instanceof Error ? err.message : String(err) },
         "rate-throttle: failed to read settings (defaulting to enabled, 5/5min)",
       );
       return { enabled: true, maxPerWindow: 5, windowMinutes: 5 };
     }
   }
   ```
2. Add the import for `countRecentNotifications` (from `../notifications/buffer`
   — check the existing import block for a `buffer` import; add one if none
   exists, or extend it).
3. In `initNotificationRoutes`, extend the `NotificationManager` constructor
   call to pass the new 5th argument:
   ```ts
   manager = new NotificationManager(
     db,
     meetingState,
     {
       context: presenceContext,
       heldQueue,
       presenceAwareRouting: () => readPresenceAwareRouting(db),
       fleetTtlMs: FLEET_HEARTBEAT_TTL_MS,
     },
     undefined, // crossMachine — unchanged, wired elsewhere if at all
     {
       settings: () => readRateThrottleSettings(db),
       countRecent: (project, channel, since) =>
         countRecentNotifications(db, project, channel, since),
     },
   );
   ```
   Check the live file for whether `crossMachine` is already passed as a 4th
   argument somewhere else (it may be `undefined` today, or wired via a
   different code path) — if `crossMachine` IS already wired with a real
   value at this call site, preserve it exactly and only add the new 5th
   argument; do not regress cross-machine delivery.

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 10: Full regression run

**Verify**: `bun test apps/agent/src/notifications/` → all pass (existing
suite + this plan's new tests, no regressions).

## Test plan

- `buffer.test.ts`: 2 new tests for `countRecentNotifications` (Step 6).
- `manager-rate-throttle.test.ts` (new file): 6 tests covering disabled,
  under-threshold, at-threshold, critical-priority-exempt,
  project-less-exempt, and no-wiring-at-all (Step 8).
- `notification-settings.test.ts`: 3 new tests for the settings fields
  (Step 4).
- Verification: `bun test apps/agent/src/notifications/` and
  `bun test apps/agent/src/routes/notification-settings.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @nexus/db typecheck` exits 0
- [ ] `pnpm --filter @nexus/agent typecheck` exits 0
- [ ] A new migration file exists under `packages/db/drizzle/` adding exactly the 3 new columns
- [ ] `bun test apps/agent/src/notifications/manager-rate-throttle.test.ts` → 6 pass, 0 fail
- [ ] `bun test apps/agent/src/notifications/buffer.test.ts` → all pass (existing 4 + 2 new)
- [ ] `bun test apps/agent/src/routes/notification-settings.test.ts` → all pass (existing + 3 new)
- [ ] `bun test apps/agent/src/notifications/` → all pass (full regression)
- [ ] No files outside the in-scope list are modified (`git status --short`)
- [ ] `plans/README.md` status row for plan 041 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- `manager.ts`'s constructor signature or `send()`'s row-construction region
  no longer matches the "Current state" excerpts — the file has drifted;
  re-read the live code before inserting Step 7's changes.
- `crossMachine` is already wired with a non-`undefined` real value at the
  `initNotificationRoutes` call site (Step 9) — do NOT overwrite it with
  `undefined`; instead preserve the existing value and only add the 5th
  argument.
- `pnpm --filter @nexus/db db:generate` produces more than 3 statements, or
  touches a table other than `notification_settings` — this would mean the
  schema diff picked up unrelated drift; report the generated SQL rather
  than manually trimming it.
- Any existing test in `apps/agent/src/notifications/` or
  `apps/agent/src/routes/notification-settings.test.ts` that passed before
  your change fails after it — the rate-throttle is designed to be fully
  additive (defaults to `null`/no-op when `rateThrottle` wiring is omitted);
  a regression here means the new code has a side effect beyond what this
  plan intends.

## Maintenance notes

- The throttle only fires for `channel === "tts"` — `desktop` and
  `telegram` notifications are never rate-limited by this mechanism (they
  are already lower-intrusiveness than audio).
- If a future change adds the real "N updates" coalesced-summary experience
  (mirroring Rule 2's meeting-hold UX) instead of a flat channel-downgrade,
  it should first independently confirm `held-queue.ts`'s flush-trigger
  semantics for non-meeting holds (see "Why this matters" above) before
  reusing that machinery — this plan deliberately did not attempt that.
- The new settings fields are patchable via the existing generic `PATCH
  /notifications/settings` route — Leo can tune `rate_throttle_max_per_window`
  /`rate_throttle_window_minutes` (or disable the feature entirely via
  `rate_throttle_enabled: false`) without a code change, using
  `curl -X PATCH http://localhost:7400/notifications/settings -d '{"rate_throttle_max_per_window": 10}'`.
- Plan 040's `GET /analytics/notifications/summary` endpoint (if it has
  landed) is the natural way to observe whether the throttle's defaults
  (5 per 5 minutes) are well-calibrated for a given project's real traffic
  after this ships — check `by_title` counts a few days post-deploy.
