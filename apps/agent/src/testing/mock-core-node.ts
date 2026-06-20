/**
 * Shared, COMPLETE `@nexus/core/node` module mock for the notification suites.
 *
 * Why this exists (same root cause as mock-nexus-db.ts — nx-509z5)
 * ────────────────────────────────────────────────────────────────
 * Several notification suites each installed their OWN
 * `mock.module("@nexus/core/node", ...)` to silence the pino logger. Because
 * `mock.module` is process-global + last-writer-wins AND
 * `cross-machine-delivery.ts` binds its logger at module-load
 * (`const log = createLogger(...)`), the suite whose import of that module
 * cached FIRST won the binding. In the full alphabetical `bun test` run a
 * manager suite's logger mock clobbered cross-machine-delivery.test.ts's own
 * spy, so `expect(loggerMock.warn).toHaveBeenCalled()` saw 0 calls and failed
 * — even though the suite passed in isolation.
 *
 * The fix
 * ───────
 * One shared logger spy object installed identically by every suite. Now the
 * process-global last-writer-wins race is harmless: whoever wins, the bound
 * logger is THE SAME `loggerSpy`, so any suite that asserts on it
 * (cross-machine-delivery) sees the real call counts. Suites that only want
 * logging silenced get exactly that.
 *
 * Usage — at the TOP of a test file, BEFORE importing the SUT:
 *
 *     import { installCoreNodeMock, loggerSpy } from "../testing/mock-core-node";
 *     installCoreNodeMock();
 *     const { forwardOrLocal } = await import("./cross-machine-delivery");
 *     // ... later: expect(loggerSpy.warn).toHaveBeenCalled();
 */

import { mock } from "bun:test";
import * as realCoreNode from "@nexus/core/node";

/**
 * The single shared logger spy. Every suite's `@nexus/core/node` mock binds
 * THIS object, so call counts are consistent regardless of module load order.
 * Call `loggerSpy.warn.mockClear()` etc. in `beforeEach` to reset between tests.
 *
 * Carries a chainable `.child` plus the pino level methods so any caller that
 * does `logger.child(...).warn(...)` works.
 */
export const loggerSpy = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  fatal: mock(() => {}),
  trace: mock(() => {}),
  child: () => loggerSpy,
};

/**
 * Install the shared `@nexus/core/node` mock for the current test process.
 *
 * CRITICAL: spreads the REAL barrel (`...realCoreNode`) and overrides ONLY the
 * logger surface + getAgentId. A partial factory would strip every other export
 * (`expandTilde`, `safeSpawn`, `resetAgentIdCache`, …) for the WHOLE process —
 * since `mock.module` is process-global + last-writer-wins, that breaks any
 * sibling suite that imports those helpers (router.ts's TTS path, the health
 * scheduler, etc.). This mirrors the spread pattern router.test.ts already uses.
 */
export function installCoreNodeMock(): void {
  mock.module("@nexus/core/node", () => ({
    ...realCoreNode,
    logger: loggerSpy,
    createLogger: () => loggerSpy,
    getAgentId: mock(() => "test-agent"),
  }));
}
