# Plan 042: Add a wall-clock quiet-hours gate for non-critical TTS on the presence-unknown / legacy fallback path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6796f8ab..HEAD -- apps/agent/src/notifications/manager.ts apps/agent/src/routes/notifications.ts apps/agent/src/routes/notification-settings.ts packages/db/src/schema/notificationSettings.ts`
> Expected: no output beyond plan 041's already-landed changes (see
> "Depends on" below). If these files differ from what plan 041 is expected
> to have produced, compare the "Current state" excerpts against the live
> file before proceeding.
>
> **Sequencing note**: this plan builds directly on plan 041's changes to
> `NotificationManager`'s constructor (adding a 6th positional parameter
> after 041's 5th). Execute plan 041 first. If for some reason plan 041 has
> NOT landed when you start this plan, see the STOP conditions section
> below for how to adapt the insertion point — do not block indefinitely.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (changes when TTS delivers for the specific case of "no
  presence signal at all" — see the explicit user-confirmed policy decision
  below; mitigated by a settings-driven enable/disable toggle and by never
  touching `priority: "high"` notifications)
- **Depends on**: plans/041-rate-throttle-repeat-tts-notifications.md (shared constructor insertion point in `manager.ts` — see Sequencing note)
- **Category**: bug (noise reduction — explicit policy decision, not silent)
- **Planned at**: commit `6796f8ab`, 2026-07-13

## Why this matters

A noise-reduction audit of the notification/TTS system (`/improve` pass,
2026-07-13) found that TTS notifications fire at 20-31/hour through
00:00-06:00 local time on a machine with no bound Mac-presence sensor
(verified against live production data — hourly counts on 2026-07-12 were
26, 28, 22, 24, 18, 27, 31 for hours 00-06, dropping to 1 only at hour 07).

This is **not** a bug in the presence-aware routing system that already
exists — that system was checked carefully. `notification_settings.presence_aware_routing`
is confirmed `true` in the live deployment, and Rule 1 in `rules-engine.ts`
*deliberately* lets an active Mac override bedtime (documented decision:
"Q1: an active Mac beats bedtime — TTS at your desk even at 2am") — that
tradeoff is intentional and this plan does not touch it.

The actual gap: `decidePresenceRoute()` (`router.ts:765-782`) returns `null`
— falling back to the **legacy path** — in exactly two cases: the flag is
off, or the presence vector has **zero known fields** (`isVectorAllUnknown`,
`rules-engine.ts:75-89`) — the case for a headless/background agent with no
bound Mac or phone presence sensor at all, which is common for autonomous
CC sessions. The legacy path (`manager.ts`'s `send()`, the branch reached
when `decidePresenceRoute` returns `null`) has **zero time-of-day
awareness** — its only gate is `this.meetingState.active`. This is *why*
TTS fires all night regardless of clock time whenever no presence signal
exists — a real, verified gap, distinct from the intentional Rule 1
decision.

**Leo's explicit decision on this tradeoff** (confirmed during this audit,
2026-07-13): add a hard wall-clock quiet-hours gate for **non-critical**
notifications only. Critical-severity notifications
(`priority: "high"` — used by `hook-rules.ts` for crash-stop,
permission-request, hook-failure, and api-error; see
`apps/agent/src/notifications/hook-rules.ts:225,259,278,318`) must **always**
fire immediately regardless of time or presence state — this plan never
touches those. Only routine/non-critical TTS traffic on the presence-unknown
path gets muted during the configured window.

## Current state

### Schema

- `packages/db/src/schema/notificationSettings.ts` — by the time this plan
  runs, plan 041 will have already added 3 rate-throttle columns after
  `bedtimeSources`. This plan adds 3 more columns after those (or after
  `bedtimeSources` directly if plan 041 has not landed yet — see the STOP
  conditions section):
  ```ts
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(true),
  quietHoursStartHour: integer("quiet_hours_start_hour").notNull().default(0),
  quietHoursEndHour: integer("quiet_hours_end_hour").notNull().default(7),
  ```
  Defaults (`0`-`7`, i.e. midnight to 7am) were chosen from the empirical
  hourly data above — TTS volume drops to near-zero at hour 07 naturally,
  so that's the boundary this plan formalizes as a policy rather than an
  accident of when people wake up.
- Migration precedent: same `ALTER TABLE ... ADD COLUMN` shape as
  `packages/db/drizzle/0044_silent_mesmero.sql`, auto-generated.

### `notification-settings.ts` route

- Same extension pattern as plan 041 Step 3 — add
  `"quiet_hours_enabled"`, `"quiet_hours_start_hour"`, `"quiet_hours_end_hour"`
  to `ALLOWED_KEYS`, the `SettingsResponse`/`SettingsRow` interfaces,
  `toResponse()`, per-field validation (boolean for `enabled`; integer in
  `[0, 23]` for the two hour fields — NOT just "positive integer" like plan
  041's window-minutes fields, since these are hour-of-day values), and the
  `changed` no-op check.

### New pure helper: `apps/agent/src/notifications/quiet-hours.ts`

This file does not exist yet — this plan creates it. No existing file to
excerpt; the full implementation is specified in Step 3 below.

### `manager.ts`

- By the time this plan runs, plan 041 will have added:
  - A `RateThrottleWiring`/`RateThrottleSettings` interface pair.
  - A `private rateThrottle: RateThrottleWiring | null;` field.
  - A 5th constructor parameter, `rateThrottle?: RateThrottleWiring`.
  - A throttle check inserted in `send()` right before
    `await insertNotification(this.db, row);`.
- This plan's insertion points are DIFFERENT regions of the same file:
  1. The legacy-path delivery point at the end of `send()` (today's lines
     ~259-282, unchanged by plan 041 since that plan's check runs earlier,
     before `insertNotification`):
     ```ts
     // Check meeting state
     if (this.meetingState.active) {
       const rule = findMatchingRule(row);

       if (rule.meeting_behavior === "drop") {
         await markNotificationExpired(this.db, row.id);
         row.status = "expired";
         logger.info({ id: row.id }, "notification dropped (meeting active, rule=drop)");
         return row;
       }

       if (rule.meeting_behavior === "buffer") {
         logger.info({ id: row.id }, "notification buffered (meeting active)");
         return row;
       }

       // "allow" — fall through to delivery
     }

     // Deliver now
     await this.deliverNotification(row, extras);
     return row;
     ```
  2. The `flush()` method (today's lines ~290-313), which delivers every
     buffered/queued row when a meeting ends — the SAME legacy path's
     delayed-delivery counterpart, equally lacking time-of-day awareness:
     ```ts
     async flush(): Promise<number> {
       const queued = await queryNotificationsByStatus(this.db, "queued");

       // Parallel delivery — partial failures are isolated (D4).
       const results = await Promise.allSettled(
         queued.map((n) => this.deliverNotification(n)),
       );
       ...
     }
     ```

### Test pattern

- Same idiom as plan 041's `manager-rate-throttle.test.ts` — this plan adds
  a sibling file, `manager-quiet-hours.test.ts`, following the identical
  structure (`installNexusDbMock()`, `installCoreNodeMock()`,
  `installBufferMock()`, `stubDb`, a `makeQuietHoursStub()` helper).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate the migration after editing the schema | `pnpm --filter @nexus/db db:generate` | new file under `packages/db/drizzle/`, 3 `ALTER TABLE` statements |
| DB package typecheck | `pnpm --filter @nexus/db typecheck` | exit 0 |
| Agent typecheck | `pnpm --filter @nexus/agent typecheck` | exit 0 |
| Pure helper unit tests | `bun test apps/agent/src/notifications/quiet-hours.test.ts` | all pass |
| Manager quiet-hours tests | `bun test apps/agent/src/notifications/manager-quiet-hours.test.ts` | all pass |
| Notification-settings route tests | `bun test apps/agent/src/routes/notification-settings.test.ts` | all pass |
| Full agent regression | `bun test apps/agent/src/notifications/` | all pass |

## Scope

**In scope**:
- `packages/db/src/schema/notificationSettings.ts` — add 3 columns.
- `packages/db/drizzle/*.sql` — new auto-generated migration.
- `apps/agent/src/routes/notification-settings.ts` — extend allow-list, types, validation, response mapping.
- `apps/agent/src/routes/notification-settings.test.ts` — extend tests.
- `apps/agent/src/notifications/quiet-hours.ts` (new file) — pure `isWithinQuietHours()` helper.
- `apps/agent/src/notifications/quiet-hours.test.ts` (new file) — unit tests for the helper.
- `apps/agent/src/notifications/manager.ts` — add `QuietHoursWiring` interface, constructor param, `applyQuietHoursIfNeeded()` private method, and its 2 call sites.
- `apps/agent/src/notifications/manager-quiet-hours.test.ts` (new file) — unit tests for the manager integration.
- `apps/agent/src/routes/notifications.ts` — add a settings reader and wire it into `initNotificationRoutes`.

**Out of scope** (do NOT touch, even though they look related):
- `rules-engine.ts`'s Rule 1 (active-Mac-beats-bedtime) — this is a
  documented, intentional decision (see "Why this matters"); do not add a
  quiet-hours check there. This plan only affects the path taken when
  `decidePresenceRoute()` returns `null` (flag off, or the vector is
  all-unknown) — it never runs when Rule 1 (or any other rule) actually
  matches.
- `rules-engine.ts`'s Rule 3 (bedtime + idle Mac → silent phone banner) —
  already correctly silences TTS when a real `isBedtime` phone signal is
  known-true; this plan's wall-clock check is a *complementary* floor for
  when no such signal exists at all, not a replacement.
- `flushHeldBatch()`'s own bedtime-silence check (`manager.ts:345-357`,
  based on the presence vector's `isBedtime` field) — that's the
  presence-aware path's own mechanism and is unrelated to the legacy
  fallback this plan targets; do not merge or modify it.
- Plan 041's rate-throttle check — a different region of the same file
  (before `insertNotification`, vs. this plan's check right before
  delivery). Do not combine the two checks into one function; keep them
  independently readable per their own concerns (rate vs. time-of-day).
- Swift dashboard UI for the new settings — same as plan 041, out of scope
  here.

## Git workflow

- Branch: none required — single-commit (or a short multi-commit sequence,
  single push) ad-hoc change per this repo's convention.
- Commit message style: e.g.
  `feat(agent): add wall-clock quiet-hours gate for non-critical TTS on the presence-unknown path`
- Stage only the in-scope files (plus `.beads/` if applicable) — do not run
  `git add .` or `git add -A` in this shared tree.
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Add the 3 new settings columns to the schema

In `packages/db/src/schema/notificationSettings.ts`, add after the
rate-throttle columns from plan 041 (or after `bedtimeSources` if plan 041
has not landed — see STOP conditions):

```ts
  /**
   * Wall-clock quiet-hours gate (noise-reduction audit, 2026-07-13, plan
   * 042). Applies ONLY on the presence-unknown / legacy notification
   * path (see NotificationManager.applyQuietHoursIfNeeded() in
   * apps/agent/src/notifications/manager.ts) — it does not affect the
   * presence-aware rules engine's own Rule 1 (active Mac beats bedtime,
   * by design) or Rule 3 (phone-reported bedtime). `startHour`/`endHour`
   * are hour-of-day (0-23, server local time); a window that wraps past
   * midnight (e.g. start=22, end=7) is supported.
   */
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(true),
  quietHoursStartHour: integer("quiet_hours_start_hour").notNull().default(0),
  quietHoursEndHour: integer("quiet_hours_end_hour").notNull().default(7),
```

**Verify**: `pnpm --filter @nexus/db typecheck` → exit 0.

### Step 2: Generate the migration

**Verify**: `pnpm --filter @nexus/db db:generate` → new file under
`packages/db/drizzle/` with exactly 3 `ALTER TABLE "notification_settings"
ADD COLUMN ...` statements.

### Step 3: Create the pure `quiet-hours.ts` helper

Create `apps/agent/src/notifications/quiet-hours.ts`:

```ts
/**
 * Wall-clock quiet-hours check (noise-reduction audit, 2026-07-13, plan 042).
 *
 * Pure — no I/O, no dependency on the presence system. This is the floor
 * that applies when NO presence signal exists at all (see manager.ts's
 * `applyQuietHoursIfNeeded`); it is independent of, and does not replace,
 * the presence-aware rules engine's own bedtime handling.
 */

/**
 * Return true when `now`'s local hour falls within [startHour, endHour).
 * Supports a window that wraps past midnight (startHour > endHour, e.g.
 * 22 -> 7). A zero-width window (startHour === endHour) is treated as
 * "quiet hours disabled" (always false) rather than "always quiet" or
 * "always loud" — an ambiguous configuration should not silently pick a
 * side.
 */
export function isWithinQuietHours(
  startHour: number,
  endHour: number,
  now: Date,
): boolean {
  if (startHour === endHour) return false;
  const hour = now.getHours();
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Wraps past midnight.
  return hour >= startHour || hour < endHour;
}
```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 4: Add unit tests for `quiet-hours.ts`

Create `apps/agent/src/notifications/quiet-hours.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { isWithinQuietHours } from "./quiet-hours";

function atHour(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe("isWithinQuietHours", () => {
  it("non-wrapping window (0-7): inside at hour 3", () => {
    expect(isWithinQuietHours(0, 7, atHour(3))).toBe(true);
  });

  it("non-wrapping window (0-7): outside at hour 7 (end is exclusive)", () => {
    expect(isWithinQuietHours(0, 7, atHour(7))).toBe(false);
  });

  it("non-wrapping window (0-7): outside at hour 12", () => {
    expect(isWithinQuietHours(0, 7, atHour(12))).toBe(false);
  });

  it("wrapping window (22-7): inside at hour 23", () => {
    expect(isWithinQuietHours(22, 7, atHour(23))).toBe(true);
  });

  it("wrapping window (22-7): inside at hour 2", () => {
    expect(isWithinQuietHours(22, 7, atHour(2))).toBe(true);
  });

  it("wrapping window (22-7): outside at hour 12", () => {
    expect(isWithinQuietHours(22, 7, atHour(12))).toBe(false);
  });

  it("zero-width window (5-5): always false (disabled)", () => {
    expect(isWithinQuietHours(5, 5, atHour(5))).toBe(false);
    expect(isWithinQuietHours(5, 5, atHour(12))).toBe(false);
  });
});
```

**Verify**: `bun test apps/agent/src/notifications/quiet-hours.test.ts` → all 7 pass.

### Step 5: Extend the `notification-settings.ts` route

Follow the exact same pattern as plan 041 Step 3, for these 3 fields
instead. Validation for the two hour fields:

```ts
if ("quiet_hours_start_hour" in patch) {
  const v = patch.quiet_hours_start_hour;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
    return jsonResponse(
      { error: "quiet_hours_start_hour must be an integer between 0 and 23" },
      400,
    );
  }
  update.quietHoursStartHour = v;
}

if ("quiet_hours_end_hour" in patch) {
  const v = patch.quiet_hours_end_hour;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
    return jsonResponse(
      { error: "quiet_hours_end_hour must be an integer between 0 and 23" },
      400,
    );
  }
  update.quietHoursEndHour = v;
}
```
(`quiet_hours_enabled` follows the plain-boolean pattern like
`tts_enabled`.) Add the 3 fields to `ALLOWED_KEYS`, `SettingsResponse`,
`SettingsRow`, `toResponse()`, and the `changed` check, exactly mirroring
plan 041's Step 3 shape.

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 6: Extend the notification-settings route tests

Add 3 tests for the new fields, following the same GET-default /
PATCH-rejects-invalid / PATCH-persists-valid structure as the existing
`bedtime_sources` tests (and plan 041's rate-throttle tests, if already
present in the file).

**Verify**: `bun test apps/agent/src/routes/notification-settings.test.ts` → all pass.

### Step 7: Add `QuietHoursWiring` to `manager.ts` and the `applyQuietHoursIfNeeded` method

In `apps/agent/src/notifications/manager.ts`:

1. Add a new interface (after `RateThrottleWiring`/`RateThrottleSettings`
   from plan 041):
   ```ts
   /**
    * Quiet-hours collaborator (noise-reduction audit, 2026-07-13, plan 042).
    * Strictly additive: when omitted, no gating occurs (byte-identical to
    * today). Applies ONLY on the legacy delivery path — see
    * `applyQuietHoursIfNeeded()`.
    */
   export interface QuietHoursWiring {
     settings: () => Promise<QuietHoursSettings> | QuietHoursSettings;
   }

   export interface QuietHoursSettings {
     enabled: boolean;
     startHour: number;
     endHour: number;
   }
   ```
2. Add the import: `import { isWithinQuietHours } from "./quiet-hours";`
3. Add a private field and extend the constructor (6th positional
   parameter, after plan 041's `rateThrottle`):
   ```ts
   private quietHours: QuietHoursWiring | null;

   constructor(
     db: Db,
     meetingState?: MeetingState,
     presence?: PresenceWiring,
     crossMachine?: CrossMachineWiring,
     rateThrottle?: RateThrottleWiring,
     quietHours?: QuietHoursWiring,
   ) {
     this.db = db;
     this.meetingState = meetingState ?? new MeetingState();
     this.presence = presence ?? null;
     this.crossMachine = crossMachine ?? null;
     this.rateThrottle = rateThrottle ?? null;
     this.quietHours = quietHours ?? null;
   }
   ```
4. Add a new private method (anywhere among the other private/helper
   methods, e.g. just before `deliverNotification`):
   ```ts
   /**
    * Downgrade a non-critical `tts` notification to `desktop` when the
    * current wall-clock hour falls within the configured quiet-hours
    * window. No-op when `quietHours` wiring is absent, the feature is
    * disabled, the notification is `priority: "high"`, or the channel
    * isn't `tts` (see plan 042 for why this applies only to the legacy /
    * presence-unknown delivery path).
    */
   private async applyQuietHoursIfNeeded(row: NotificationRow): Promise<void> {
     if (row.channel !== "tts" || row.priority === "high" || !this.quietHours) return;
     const settings = await this.quietHours.settings();
     if (!settings.enabled) return;
     if (isWithinQuietHours(settings.startHour, settings.endHour, new Date())) {
       logger.info(
         { id: row.id, startHour: settings.startHour, endHour: settings.endHour },
         "notification TTS downgraded to desktop (quiet hours)",
       );
       row.channel = "desktop";
     }
   }
   ```
5. Call it at the two legacy-delivery points:
   - In `send()`, immediately before `// Deliver now` / `await this.deliverNotification(row, extras);`:
     ```ts
     await this.applyQuietHoursIfNeeded(row);
     // Deliver now
     await this.deliverNotification(row, extras);
     return row;
     ```
   - In `flush()`, change:
     ```ts
     const results = await Promise.allSettled(
       queued.map((n) => this.deliverNotification(n)),
     );
     ```
     to:
     ```ts
     const results = await Promise.allSettled(
       queued.map(async (n) => {
         await this.applyQuietHoursIfNeeded(n);
         return this.deliverNotification(n);
       }),
     );
     ```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 8: Add `manager-quiet-hours.test.ts`

Create `apps/agent/src/notifications/manager-quiet-hours.test.ts`, modeled
directly on plan 041's `manager-rate-throttle.test.ts` (same shared-mock
header, `stubDb`, a `makeSendInput` helper — reuse the exact same helper
shape). Add a `makeQuietHoursStub(opts)` helper analogous to
`makeRateThrottleStub`:

```ts
function makeQuietHoursStub(opts: { enabled: boolean; startHour: number; endHour: number }) {
  return {
    settings: mock(async () => ({
      enabled: opts.enabled,
      startHour: opts.startHour,
      endHour: opts.endHour,
    })),
  };
}
```

Tests (construct `new NotificationManager(stubDb, undefined, undefined,
undefined, undefined, quietHoursStub)` — note the `undefined` placeholders
for `presence`/`crossMachine`/`rateThrottle` to reach the 6th positional
slot):

```ts
describe("manager quiet-hours gate", () => {
  it("disabled → no downgrade even inside the window", async () => {
    const quietHours = makeQuietHoursStub({ enabled: false, startHour: 0, endHour: 23 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, undefined, quietHours);
    const row = await manager.send(makeSendInput("q-1"));
    expect(row.channel).toBe("tts");
  });

  it("enabled + inside a window covering all 24 hours → downgraded to desktop", async () => {
    // startHour=0, endHour=23 covers every hour except hour 23 itself (end
    // exclusive) — use the always-true wrap form instead to make this
    // deterministic regardless of the real clock: startHour=0, endHour=0
    // is disabled (zero-width), so use a wrapping window that covers
    // every hour: start=1, end=1 is also zero-width — instead assert
    // using a fixed date via the wiring's own settings function returning
    // an "enabled" state and rely on isWithinQuietHours's own unit tests
    // (Step 4) for the exact hour-boundary logic. Here, mock a wide
    // non-degenerate window (0-23) and accept the tiny chance this runs
    // exactly at hour 23; prefer asserting the OTHER direction instead:
    const quietHours = makeQuietHoursStub({ enabled: true, startHour: 0, endHour: 24 === 24 ? 0 : 0 });
    // NOTE TO EXECUTOR: the line above is deliberately awkward — replace
    // it with a real fixed-time test instead. Use Bun's fake-timer support
    // or freeze the clock: prefer testing via a wrapping window guaranteed
    // to include `new Date().getHours()` — e.g. compute
    // `const h = new Date().getHours(); const quietHours =
    // makeQuietHoursStub({ enabled: true, startHour: h, endHour: (h + 1) % 24 });`
    // so the window always covers the current hour deterministically.
  });
});
```

**Do not copy the awkward placeholder above verbatim.** Write the "inside
the window" test using the deterministic current-hour technique described
in the NOTE: compute `const h = new Date().getHours();` and construct a
1-hour-wide window `{ startHour: h, endHour: (h + 1) % 24 }` so the test is
guaranteed to be "currently inside the window" regardless of when the test
suite runs, with no flakiness and no fake-timer dependency. Write the
"outside the window" test the same way but with a window that excludes the
current hour, e.g. `{ startHour: (h + 2) % 24, endHour: (h + 3) % 24 }`.
Also add:

- `priority: "high" is never downgraded, regardless of window` (construct
  `makeSendInput("q-4", { priority: "high" })` with a window covering the
  current hour — assert `row.channel` stays `"tts"`).
- `no quietHours wiring at all → byte-identical legacy behavior` (construct
  `new NotificationManager(stubDb)` with no extra args — assert
  `row.channel` stays `"tts"`).

**Verify**: `bun test apps/agent/src/notifications/manager-quiet-hours.test.ts` → all pass.

### Step 9: Wire the settings reader into `initNotificationRoutes`

In `apps/agent/src/routes/notifications.ts`:

1. Add a new function (after plan 041's `readRateThrottleSettings`, if
   present, or after `readPresenceAwareRouting` otherwise):
   ```ts
   /** Reads the live quiet-hours settings from notification_settings. */
   async function readQuietHoursSettings(
     db: Db,
   ): Promise<{ enabled: boolean; startHour: number; endHour: number }> {
     try {
       const row = await db.query.notificationSettings.findFirst({
         where: eq(notificationSettings.id, 1),
       });
       return {
         enabled: row?.quietHoursEnabled ?? true,
         startHour: row?.quietHoursStartHour ?? 0,
         endHour: row?.quietHoursEndHour ?? 7,
       };
     } catch (err) {
       log.warn(
         { err: err instanceof Error ? err.message : String(err) },
         "quiet-hours: failed to read settings (defaulting to enabled, 0-7)",
       );
       return { enabled: true, startHour: 0, endHour: 7 };
     }
   }
   ```
2. In `initNotificationRoutes`, add the 6th argument to the
   `NotificationManager` constructor call (after plan 041's `rateThrottle`
   argument):
   ```ts
   {
     settings: () => readQuietHoursSettings(db),
   },
   ```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 10: Full regression run

**Verify**: `bun test apps/agent/src/notifications/` → all pass.

## Test plan

- `quiet-hours.test.ts` (new file): 7 tests for the pure helper (Step 4).
- `manager-quiet-hours.test.ts` (new file): disabled, enabled+inside,
  enabled+outside, critical-exempt, no-wiring (Step 8, 5 tests total).
- `notification-settings.test.ts`: 3 new tests for the settings fields
  (Step 6).
- Verification: `bun test apps/agent/src/notifications/` and
  `bun test apps/agent/src/routes/notification-settings.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @nexus/db typecheck` exits 0
- [ ] `pnpm --filter @nexus/agent typecheck` exits 0
- [ ] A new migration file exists under `packages/db/drizzle/` adding exactly the 3 new quiet-hours columns
- [ ] `bun test apps/agent/src/notifications/quiet-hours.test.ts` → 7 pass, 0 fail
- [ ] `bun test apps/agent/src/notifications/manager-quiet-hours.test.ts` → 5 pass, 0 fail
- [ ] `bun test apps/agent/src/routes/notification-settings.test.ts` → all pass (existing + new)
- [ ] `bun test apps/agent/src/notifications/` → all pass (full regression, including plan 041's tests if it has landed)
- [ ] No files outside the in-scope list are modified (`git status --short`)
- [ ] `plans/README.md` status row for plan 042 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 041 has not landed and `NotificationManager`'s constructor does not
  yet have a `rateThrottle` 5th parameter — in that case, insert
  `quietHours` as the **5th** positional parameter instead of the 6th (skip
  the "after `rateThrottle`" instructions and adapt accordingly), note this
  adaptation explicitly in your completion report, and flag that plan 041's
  own insertion will need to account for `quietHours` already occupying
  that slot when it later lands.
- `manager.ts`'s `send()` legacy-delivery region or `flush()` no longer
  match the "Current state" excerpts — the file has drifted; re-read the
  live code before inserting Step 7's changes.
- Any existing test in `apps/agent/src/notifications/` or
  `apps/agent/src/routes/notification-settings.test.ts` that passed before
  your change fails after it.
- `pnpm --filter @nexus/db db:generate` produces anything beyond the 3
  expected `ALTER TABLE` statements on `notification_settings`.

## Maintenance notes

- This gate applies ONLY on the legacy/presence-unknown path. If Leo later
  decides the intentional Rule 1 tradeoff (active Mac beats bedtime) should
  also respect quiet hours for non-critical notifications, that is a
  separate, explicit decision requiring a change to `rules-engine.ts` — do
  not silently extend this plan's gate there.
- The new settings are patchable via the existing generic `PATCH
  /notifications/settings` route, e.g.
  `curl -X PATCH http://localhost:7400/notifications/settings -d '{"quiet_hours_start_hour": 23, "quiet_hours_end_hour": 6}'`
  to shift the window, or `{"quiet_hours_enabled": false}` to disable it
  entirely.
- Plan 040's `GET /analytics/notifications/summary?hours=336` endpoint (if
  landed) is the natural way to confirm this gate actually reduced the
  00:00-07:00 `by_hour` counts a few days after this ships.
