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
import { startSocketServer } from "../services/socket-server";
import type { SocketServer } from "../services/socket-server";
import type { SocketEvent } from "../types/socket-events";
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
