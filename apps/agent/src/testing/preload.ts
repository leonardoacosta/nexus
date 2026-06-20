/**
 * Bun test preload (wired via apps/agent/bunfig.toml `[test].preload`).
 *
 * Why this exists (nx-509z5 mock-load-order race)
 * ───────────────────────────────────────────────
 * `cross-machine-delivery.ts` binds its logger at MODULE LOAD:
 *   `const log = createLogger("agent:notifications:cross-machine-delivery");`
 * `cross-machine-delivery.test.ts` asserts on that logger via the shared
 * `loggerSpy` (testing/mock-core-node.ts). For the spy to win, the module's
 * `createLogger` must already be mocked when the SUT FIRST loads anywhere in
 * the worker process.
 *
 * In the full `bun test src/` run, dozens of suites transitively load the
 * cross-machine chain (`../server` -> server-request-handler -> manager ->
 * cross-machine-delivery) — many BEFORE cross-machine-delivery.test.ts runs its
 * own `installCoreNodeMock()`. Whichever suite triggers that first load with
 * the REAL pino logger active wins the module-load binding, and the spy reads 0
 * calls. This race is parallel-scheduler-dependent and does NOT reproduce in
 * small subsets — only the full run. A preload is the canonical fix: it installs
 * the shared core/node logger mock ONCE, per worker, BEFORE any test file (and
 * therefore before any SUT) loads, so the SUT's module-load `createLogger()`
 * ALWAYS resolves the shared spy regardless of load order.
 *
 * Scope: ONLY the logger surface is overridden (`...realCoreNode` is spread, so
 * `safeSpawn`/`getAgentId`/`expandTilde`/etc. stay real). `getAgentId` is NOT
 * mocked here — suites that need a deterministic id still call
 * `installCoreNodeMock({ mockGetAgentId: true })` themselves, and suites with a
 * PRIVATE `mock.module("@nexus/core/node", ...)` (e.g. notifications/channels)
 * still win for their own files since their factory runs after this preload.
 */

import { installCoreNodeMock } from "./mock-core-node";

installCoreNodeMock({ mockGetAgentId: false });
