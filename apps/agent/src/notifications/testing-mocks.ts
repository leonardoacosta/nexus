/**
 * Shared, RESTORABLE buffer mock for the notification manager suites (nx-509z5).
 *
 * Root cause
 * ──────────
 * The manager suites need `./buffer`'s four DB-writer helpers no-op'd (no live
 * PG). They used to do this with `mock.module("./buffer", () => ({ …partial }))`
 * — but `mock.module` is process-global, last-writer-wins, AND irreversible:
 *   - the partial factory omitted `getNotificationById`, so `buffer.test.ts`
 *     later threw `SyntaxError: Export named 'getNotificationById' not found`;
 *   - the no-op `insertNotification` leaked into `reliability-regression.test.ts`
 *     (which calls the REAL `insertNotification` and asserts it writes a row),
 *     so its "insertNotification still persists" test saw 0 writes.
 *
 * Fix
 * ───
 * Use `spyOn(bufferNs, …)` instead of `mock.module`. `spyOn` is RESTORABLE: the
 * returned handle's `.restore()` (call in the suite's `afterAll`) reverts every
 * export to the real function, so sibling suites that load LATER get the real
 * `./buffer`. The manager's static `import { insertNotification }` sees the spy
 * via the ESM live binding while the spy is active.
 *
 * The restore handle is per-call (NOT module-level state) so multiple suites
 * mocking buffer in the same process don't stomp each other's restore set —
 * each suite restores exactly the spies it installed.
 *
 * This file lives next to the suites (not in ../testing) because it must
 * `import * from` the sibling `./buffer` module.
 */

import { spyOn } from "bun:test";
import * as bufferNs from "./buffer";

/** Restore handle returned by {@link installBufferMock}. */
export interface BufferMockHandle {
  /** Revert all four writers to the real `./buffer` functions. */
  restore(): void;
}

/**
 * Spy the four `./buffer` DB-writer helpers as resolved no-ops (no live PG).
 * `getNotificationById` and every other export stay REAL. Call `.restore()` on
 * the returned handle in `afterAll` so later suites get the real module back.
 */
export function installBufferMock(): BufferMockHandle {
  const spies = [
    spyOn(bufferNs, "insertNotification").mockImplementation(async () => {}),
    spyOn(bufferNs, "queryNotificationsByStatus").mockImplementation(
      async () => [],
    ),
    spyOn(bufferNs, "markNotificationDelivered").mockImplementation(
      async () => {},
    ),
    spyOn(bufferNs, "markNotificationExpired").mockImplementation(
      async () => {},
    ),
  ];
  return {
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
