/**
 * Homelab-local transport check (add-fullstack-integration-test-gate 1.3).
 *
 * This is the half of the transport seam the client-side stub is blind to:
 * it runs ON the agent host against its OWN loopback (deterministic, no
 * Tailscale dependency / no cross-host network) and asserts three things the
 * dashboard-empty incident proved were silently broken:
 *
 *   1. Bind shape — the agent's default bind routing binds the configured
 *      NON-loopback interface (not loopback-only) whenever a Tailscale IPv4
 *      is discoverable. Loopback-only is a valid *degraded* mode only when
 *      Tailscale is genuinely absent; this test fails if the routing would
 *      have stayed loopback-only despite a usable interface.
 *   2. Contract shape — `/sessions` and `/health` decode to the canonical
 *      `packages/core` / `@nexus/db` shapes (response-shape drift guard).
 *   3. Socket spine — a `nexus-emit`-style NDJSON `session_start` event
 *      round-trips through the real socket server into the dispatcher.
 *
 * Requires a live PG for the HTTP contract leg (skips cleanly when unset).
 * The bind + socket-spine legs run unconditionally.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server as BunServer } from "bun";
import type { WsData } from "../terminal/stream-manager";
import { __testing, startServer, type NexusServer } from "../server";
import { startSocketServer, createSocketEventDispatcher } from "../services/socket-server";
import type { SocketServer } from "../services/socket-server";
import type { SocketEvent } from "../types/socket-events";
import { createSessionManager } from "../session-manager";
import { lifecycleBus } from "../services/lifecycle-bus";
import { openDatabase } from "../db/database";
import type { Db } from "@nexus/db";

const hasPg = !!process.env.POSTGRES_URL;

// Heavyweight/capability gate. This check is the "runs ON the agent host"
// transport leg — it stands up real servers and (for the HTTP contract leg)
// needs a live agent/PG. The bare per-push `turbo test` MUST stay fast and
// not depend on agent-host capabilities, so it never sets NEXUS_HEAVY_TESTS
// and this whole file skips cleanly there. The gate's resource-bearing
// Tier A path sets NEXUS_HEAVY_TESTS=1 to exercise the transport seam; the
// HTTP-contract leg additionally keeps its own hasPg guard so it still skips
// cleanly when PG is absent even under the heavy flag.
const heavyEnabled = process.env.NEXUS_HEAVY_TESTS === "1";

// ── 1. Bind shape — non-loopback interface, not loopback-only ──────────────

describe.skipIf(!heavyEnabled)("homelab transport — agent binds the non-loopback interface", () => {
  it("default routing is NOT loopback-only when Tailscale is discoverable", () => {
    const calls: string[] = [];
    const fakeFactory = (hostname: string) => {
      calls.push(hostname);
      return { hostname, port: 7400 } as unknown as BunServer<WsData>;
    };

    // Mirrors production startServer() default path exactly.
    const tsIp = __testing.discoverTailscaleIp();
    __testing.bindServers(undefined, fakeFactory);

    // Loopback is always first (local IPC keeps working).
    expect(calls[0]).toBe("127.0.0.1");

    if (tsIp === null) {
      // Tailscale genuinely absent → loopback-only is the documented
      // degraded mode. Nothing to assert beyond "did not crash".
      expect(calls).toEqual(["127.0.0.1"]);
      return;
    }

    // Tailscale present → the agent MUST also bind the non-loopback
    // interface. A loopback-only bind here is the nx- bind regression.
    expect(calls.length).toBe(2);
    expect(calls[1]).toBe(tsIp);
    expect(calls[1]).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    expect(calls[1]).not.toBe("127.0.0.1");
    expect(calls[1]!.startsWith("127.")).toBe(false);
  });
});

// ── 2. Contract shape — /sessions + /health match the core contract ───────

describe.skipIf(!heavyEnabled || !hasPg)(
  "homelab transport — HTTP contract shape (requires live PG)",
  () => {
    let server: NexusServer;
    let db: Db;
    let base: string;
    let cfgDir: string;
    const prevCfgDir = process.env.NEXUS_CONFIG_DIR;

    beforeAll(() => {
      db = openDatabase();
      // Force the explicit-bind-address path: an on-host agents.toml with
      // bind_address = "127.0.0.1" makes startServer() a single deterministic
      // loopback bind with NO Tailscale shell-out. This is the "runs on the
      // agent host against its own loopback" contract from the spec.
      cfgDir = mkdtempSync(join(tmpdir(), "nx-itg-cfg-"));
      writeFileSync(
        join(cfgDir, "agents.toml"),
        'bind_address = "127.0.0.1"\n',
      );
      process.env.NEXUS_CONFIG_DIR = cfgDir;

      server = startServer(0, db);
      base = `http://127.0.0.1:${server.port}`;
    });

    afterAll(() => {
      server.stop(true);
      if (prevCfgDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
      else process.env.NEXUS_CONFIG_DIR = prevCfgDir;
      rmSync(cfgDir, { recursive: true, force: true });
    });

    it("GET /health decodes to the HealthMetrics contract", async () => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // HealthMetrics required fields (packages/core types/health.ts).
      expect(typeof body.hostname).toBe("string");
      expect(typeof body.uptime_seconds).toBe("number");
      expect(body.cpu).toBeDefined();
      const cpu = body.cpu as Record<string, unknown>;
      expect(typeof cpu.overall_percent).toBe("number");
      expect(Array.isArray(cpu.per_core_percent)).toBe(true);
      expect(Array.isArray(cpu.load_average)).toBe(true);
      const ram = body.ram as Record<string, unknown>;
      expect(typeof ram.total_bytes).toBe("number");
      expect(typeof ram.percent).toBe("number");
      expect(Array.isArray(body.disk)).toBe(true);
    });

    it("GET /sessions decodes to the SessionRow[] contract", async () => {
      const res = await fetch(`${base}/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(Array.isArray(body)).toBe(true);
      // The shape contract is exercised even when empty: an empty array is
      // a valid SessionRow[]. When non-empty, spot-check the column set.
      if (body.length > 0) {
        const row = body[0] as Record<string, unknown>;
        for (const key of [
          "id",
          "machine",
          "status",
          "startedAt",
          "lastActivity",
          "pid",
        ]) {
          expect(key in row).toBe(true);
        }
      }
    });

    // ── 2b. Liveness — db_ok / last_watcher_tick_ms / socket_server_listening ──
    //
    // The /health payload now extends HealthMetrics with three liveness
    // fields. They MUST be present on every response and report healthy
    // values when PG is live and a watcher pass has completed. See
    // test-infrastructure spec § Health Endpoint Liveness Fields.
    //
    // The watcher's first reconcile is fire-and-forget at startServer() —
    // poll briefly so the assertion is deterministic.
    it("GET /health surfaces liveness fields (db_ok, last_watcher_tick_ms, socket_server_listening)", async () => {
      const deadline = Date.now() + 5_000;
      let body: Record<string, unknown> = {};
      let res: Response;

      while (Date.now() < deadline) {
        res = await fetch(`${base}/health`);
        expect(res.status).toBe(200);
        body = (await res.json()) as Record<string, unknown>;
        if (body.db_ok === true && typeof body.last_watcher_tick_ms === "number" &&
            (body.last_watcher_tick_ms as number) >= 0) {
          break;
        }
        await Bun.sleep(50);
      }

      // db_ok — PG is live in this leg (hasPg gate above); ping MUST succeed.
      expect(body.db_ok).toBe(true);

      // last_watcher_tick_ms — watcher has ticked at least once → non-negative
      // and well inside the 5-minute window on a healthy agent.
      expect(typeof body.last_watcher_tick_ms).toBe("number");
      const tickMs = body.last_watcher_tick_ms as number;
      expect(tickMs).toBeGreaterThanOrEqual(0);
      expect(tickMs).toBeLessThan(5 * 60_000);

      // socket_server_listening — the spine round-trip block below starts a
      // socket server; whether it has run yet depends on bun-test ordering.
      // Assert the field is present + boolean to pin the contract.
      expect(typeof body.socket_server_listening).toBe("boolean");
    });
  },
);

// ── 3. Socket spine — nexus-emit NDJSON round-trips to the dispatcher ─────

describe.skipIf(!heavyEnabled)("homelab transport — socket spine round-trip", () => {
  let socketServer: SocketServer;
  const socketPath = `/tmp/nx-itg-spine-${Date.now()}.sock`;
  const observed: SocketEvent[] = [];

  beforeAll(async () => {
    socketServer = await startSocketServer({
      socketPath,
      onEvent: (event) => {
        observed.push(event);
      },
      onCommand: () => ({ error: "no commands in this test" }),
    });
  });

  afterAll(() => {
    socketServer.stop();
  });

  it("a session_start NDJSON line written to the socket reaches the dispatcher", async () => {
    const payload: SocketEvent = {
      event: "session_start",
      session_id: "spine-roundtrip-1",
      project: "nx",
      cwd: "/tmp/spine",
      model: "claude",
    };

    // This is exactly the nexus-emit wire protocol: connect to the unix
    // socket, write one JSON line + "\n", close.
    await new Promise<void>((resolve, reject) => {
      Bun.connect({
        unix: socketPath,
        socket: {
          open(sock) {
            sock.write(JSON.stringify(payload) + "\n");
            sock.end();
          },
          data() {},
          close() {
            resolve();
          },
          error(_s, err) {
            reject(err);
          },
        },
      }).catch(reject);
    });

    // The socket server processes the line asynchronously; poll briefly.
    const deadline = Date.now() + 2000;
    while (
      !observed.some(
        (e) => e.event === "session_start" && e.session_id === "spine-roundtrip-1",
      ) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(25);
    }

    const got = observed.find(
      (e) => e.event === "session_start" && e.session_id === "spine-roundtrip-1",
    );
    expect(got).toBeDefined();
    expect(got!.event).toBe("session_start");
  });
});

// ── 4. Live-session socket-spine injection → /sessions read path ──────────
//
// Builds on the spine round-trip above, but wires the REAL dispatcher
// (createSocketEventDispatcher with sessionManager + db) so the agent
// actually inserts the fixture row into PG. Then polls /sessions over HTTP
// until the row materialises. Proves the full inject→dispatch→DB→read
// pipeline that production hooks rely on.
//
// Gated on heavyEnabled AND hasPg — the dispatcher's INSERT goes through
// Drizzle, so without PG the test cannot succeed (and skipping cleanly is
// what the spec demands).

describe.skipIf(!heavyEnabled || !hasPg)(
  "homelab transport — socket-spine injection materialises in /sessions (requires live PG)",
  () => {
    let server: NexusServer;
    let socketServer: SocketServer;
    let db: Db;
    let base: string;
    let cfgDir: string;
    const prevCfgDir = process.env.NEXUS_CONFIG_DIR;
    const socketPath = `/tmp/nx-itg-live-${Date.now()}-${process.pid}.sock`;
    // Deterministic-but-unique id avoids races with real sessions on the host.
    const fixtureId = `gate-fixture-${Date.now()}-${process.pid}`;

    beforeAll(async () => {
      db = openDatabase();

      // Force loopback-only bind (same trick as the contract-shape leg).
      cfgDir = mkdtempSync(join(tmpdir(), "nx-itg-live-cfg-"));
      writeFileSync(
        join(cfgDir, "agents.toml"),
        'bind_address = "127.0.0.1"\n',
      );
      process.env.NEXUS_CONFIG_DIR = cfgDir;

      server = startServer(0, db);
      base = `http://127.0.0.1:${server.port}`;

      // Real dispatcher: socket events → sessionManager → PG insert.
      const sessionManager = createSessionManager({ db });
      const dispatch = createSocketEventDispatcher({ sessionManager, lifecycleBus, db });
      socketServer = await startSocketServer({
        socketPath,
        onEvent: dispatch,
        onCommand: () => ({ error: "no commands in this test" }),
      });
    });

    afterAll(async () => {
      // Always emit session_end so the fixture row is closed even if
      // assertions failed mid-test. Try/finally guards both the cleanup
      // emit and the resource teardown.
      try {
        await emitSocketLine(socketPath, {
          event: "session_stop",
          session_id: fixtureId,
        });
      } finally {
        try {
          socketServer?.stop();
        } finally {
          try {
            server?.stop(true);
          } finally {
            if (prevCfgDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
            else process.env.NEXUS_CONFIG_DIR = prevCfgDir;
            rmSync(cfgDir, { recursive: true, force: true });
          }
        }
      }
    });

    it("session_start injected via socket appears in GET /sessions with canonical shape", async () => {
      await emitSocketLine(socketPath, {
        event: "session_start",
        session_id: fixtureId,
        project: "nx",
        cwd: "/tmp/gate-fixture",
        model: "claude",
      });

      // Poll /sessions for up to 2s waiting for the dispatcher to write
      // the row and the read path to surface it.
      const deadline = Date.now() + 2000;
      let row: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/sessions`);
        if (res.status === 200) {
          const body = (await res.json()) as Array<Record<string, unknown>>;
          row = body.find((r) => r.id === fixtureId);
          if (row) break;
        }
        await Bun.sleep(25);
      }

      expect(row).toBeDefined();
      // Canonical SessionRow shape (matches the contract-shape leg above).
      for (const key of [
        "id",
        "machine",
        "status",
        "startedAt",
        "lastActivity",
        "pid",
      ]) {
        expect(key in (row as Record<string, unknown>)).toBe(true);
      }
      expect((row as Record<string, unknown>).id).toBe(fixtureId);
    });
  },
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Write one NDJSON line to a unix socket and close — mirrors nexus-emit. */
async function emitSocketLine(socketPath: string, payload: SocketEvent): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write(JSON.stringify(payload) + "\n");
          sock.end();
        },
        data() {},
        close() {
          resolve();
        },
        error(_s, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}
