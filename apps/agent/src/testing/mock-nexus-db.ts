/**
 * Shared, COMPLETE `@nexus/db` module mock for the notification test suites.
 *
 * Why this exists
 * ───────────────
 * `bun test` runs every file in `apps/agent/src/notifications/` in ONE process,
 * and `mock.module(...)` is process-global + last-writer-wins. Six suites used
 * to each install their OWN partial `mock.module("@nexus/db", ...)` stub listing
 * only the handful of exports they thought they needed. Whichever file loaded
 * last clobbered the others with its (often incomplete) stub, so a static
 * `import { projectVoiceOverrides }` in router.ts — or `fleetPresence` in
 * manager.ts — resolved to `undefined` and Bun threw
 *   `SyntaxError: Export named 'projectVoiceOverrides' not found`
 * mid-suite, failing innocent neighbours (exec.test.ts, cross-machine-delivery,
 * router.test.ts) that never even touch the DB. Every suite passed in isolation
 * but the combined Tier-A `turbo test` run failed (~13 failures), gating the
 * pre-push auto-deploy hook. (beads nx-509z5.)
 *
 * The fix
 * ───────
 * One shared helper that mocks `@nexus/db` by RE-EXPORTING THE REAL MODULE
 * (`...realDb`). Spreading the real module is drift-proof: every schema table
 * (notifications, credentials, projectVoiceOverrides, presenceHolds,
 * routingRules, fleetPresence, …) and every drizzle helper (eq/and/sql/desc/…)
 * is present automatically, and a new table added to packages/db cannot
 * silently break this mock the way a hand-listed stub would.
 *
 * Process-global last-writer-wins is now HARMLESS: every suite installs the
 * SAME complete mock. Per-test behaviour stays controlled by each test's
 * injected `Db` handle / query stubs — this helper does NOT touch that layer.
 *
 * `createDb` is deliberately left REAL. The notification suites never call it
 * (they inject a fake `Db` directly); held-queue.test.ts genuinely needs the
 * real `createDb` for its live-PG path. Stubbing it here would trip
 * held-queue's `skipDueToMock` guard.
 *
 * Usage — at the TOP of a test file, BEFORE importing the modules under test:
 *
 *     import { installNexusDbMock } from "../testing/mock-nexus-db";
 *     installNexusDbMock();
 *
 *     // now load the real modules under test
 *     const { NotificationManager } = await import("./manager");
 */

import { mock } from "bun:test";
import * as realDb from "@nexus/db";

/**
 * Install the complete `@nexus/db` mock for the current Bun test process.
 *
 * Safe to call from every suite — the mock is identical regardless of which
 * file loads first, so the process-global last-writer-wins semantics no longer
 * cause cross-suite pollution.
 */
export function installNexusDbMock(): void {
  mock.module("@nexus/db", () => ({ ...realDb }));
}
