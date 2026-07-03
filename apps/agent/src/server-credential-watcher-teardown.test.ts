/**
 * Regression test for the credential-watcher shutdown leak (plan 009).
 *
 * `startServer()` starts two filesystem watchers — one over the credential pool
 * directory, one over `~/.claude/.credentials.json` — each returning an
 * `AbortController`. The bug: `server.ts` discarded both controllers, so
 * `.abort()` was never called and the underlying `fs.watch` loops + debounce
 * timers kept the event loop / fds alive after `server.stop()` returned.
 *
 * This test proves `server.stop()` aborts BOTH credential-watcher
 * `AbortController`s. It avoids Postgres by stubbing every DB-touching module
 * `startServer` calls, and replaces the two watcher functions with fakes that
 * return a real `AbortController` the test can inspect.
 *
 * Mock ordering note (mirrors server-bind.test.ts): a STATIC `import` of
 * `./server` hoists above the `mock.module` calls, so the real modules would
 * win. The dynamic `await import("./server")` AFTER the mocks guarantees the
 * stubs are bound first.
 */

import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Db } from "@nexus/db";

// Real modules are imported so the mocks can SPREAD them and override only the
// DB-touching entry points `startServer` calls. `mock.module` replaces a module
// globally, so a bare `{ startProcessWatcher }` factory would drop the other
// exports (e.g. `reconcileOnce`) that transitively-loaded routes import — hence
// the spread-then-override pattern.
import * as realNotifications from "./routes/notifications";
import * as realCredentialsRoute from "./routes/credentials";
import * as realRouter from "./notifications/router";
import * as realProcessWatcher from "./services/process-watcher";
import * as realCredentialWatcher from "./credentials/credential-watcher";

// Shared array the watcher fakes push their AbortControllers into so the test
// can inspect abort state before/after stop().
const startedControllers: AbortController[] = [];

mock.module("./routes/notifications", () => ({
  ...realNotifications,
  initNotificationRoutes: async () => {},
}));
mock.module("./routes/credentials", () => ({
  ...realCredentialsRoute,
  initCredentialRoutes: () => {},
  // Truthy pool so the `if (pool)` branch runs and starts the watchers.
  getCredentialPool: () => ({ refreshMetadata: async () => 0 }),
}));
mock.module("./notifications/router", () => ({
  ...realRouter,
  setTtsDbHandle: () => {},
}));
mock.module("./services/process-watcher", () => ({
  ...realProcessWatcher,
  startProcessWatcher: () => ({ stop: () => {} }),
}));
mock.module("./credentials/credential-watcher", () => ({
  ...realCredentialWatcher,
  startCredentialWatcher: () => {
    const ac = new AbortController();
    startedControllers.push(ac);
    return ac;
  },
  startActiveCredentialWatcher: () => {
    const ac = new AbortController();
    startedControllers.push(ac);
    return ac;
  },
}));

const { startServer } = await import("./server");

describe("server credential-watcher teardown (plan 009)", () => {
  let cfgDir: string;
  const prevCfgDir = process.env.NEXUS_CONFIG_DIR;

  beforeAll(() => {
    // Deterministic single loopback bind — no tailscale shell-out.
    cfgDir = mkdtempSync(join(tmpdir(), "nx-cred-teardown-cfg-"));
    writeFileSync(join(cfgDir, "agents.toml"), 'bind_address = "127.0.0.1"\n');
    process.env.NEXUS_CONFIG_DIR = cfgDir;
  });

  afterAll(() => {
    if (prevCfgDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
    else process.env.NEXUS_CONFIG_DIR = prevCfgDir;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it("aborts both credential-watcher AbortControllers on server.stop()", () => {
    const db = {} as unknown as Db; // stubbed modules never touch it
    const server = startServer(0, db);

    expect(startedControllers.length).toBe(2);
    expect(startedControllers.every((ac) => ac.signal.aborted)).toBe(false);

    server.stop(true);

    expect(startedControllers.length).toBe(2);
    expect(startedControllers.every((ac) => ac.signal.aborted)).toBe(true);
  });
});
