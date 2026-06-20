/**
 * Fleet-presence service tests (openspec/changes/cross-machine-delivery, Phase 1.6).
 *
 * `resolveLiveConsole` is a PURE function — unit-tested with plain row
 * fixtures, no DB. It picks the target machine for a `deliverTo:[mac]` action:
 * the `on_console` row with the newest `heartbeat` within `ttlMs` wins; if no
 * candidate qualifies, it falls back to the local machine.
 *
 * The DB-write half (`upsertSelfPresence`) is covered by a PG-gated test below.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import type { FleetPresence } from "@nexus/db";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import { resolveLiveConsole, upsertSelfPresence } from "./fleet-presence";

const TTL = 30_000;

/** Build a fleet_presence row fixture with sane defaults. */
function row(over: Partial<FleetPresence> & { machine: string }): FleetPresence {
  return {
    machine: over.machine,
    onConsole: over.onConsole ?? false,
    macActive: over.macActive ?? null,
    macLocked: over.macLocked ?? null,
    heartbeat: over.heartbeat ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
  };
}

describe("resolveLiveConsole (pure)", () => {
  const now = Date.now();

  it("picks the newest on-console machine", () => {
    const rows = [
      row({ machine: "studio", onConsole: true, heartbeat: new Date(now - 5_000) }),
      row({ machine: "laptop", onConsole: false, heartbeat: new Date(now - 1_000) }),
    ];
    expect(resolveLiveConsole(rows, "laptop", TTL, now)).toBe("studio");
  });

  it("two on-console: newest heartbeat wins", () => {
    const rows = [
      row({ machine: "studio", onConsole: true, heartbeat: new Date(now - 10_000) }),
      row({ machine: "laptop", onConsole: true, heartbeat: new Date(now - 2_000) }),
    ];
    expect(resolveLiveConsole(rows, "studio", TTL, now)).toBe("laptop");
  });

  it("no on-console row falls back to local", () => {
    const rows = [
      row({ machine: "studio", onConsole: false, heartbeat: new Date(now - 1_000) }),
      row({ machine: "laptop", onConsole: false, heartbeat: new Date(now - 1_000) }),
    ];
    expect(resolveLiveConsole(rows, "laptop", TTL, now)).toBe("laptop");
  });

  it("all on-console rows stale past TTL falls back to local", () => {
    const rows = [
      row({ machine: "studio", onConsole: true, heartbeat: new Date(now - 60_000) }),
      row({ machine: "laptop", onConsole: true, heartbeat: new Date(now - 90_000) }),
    ];
    expect(resolveLiveConsole(rows, "laptop", TTL, now)).toBe("laptop");
  });

  it("empty fleet falls back to local", () => {
    expect(resolveLiveConsole([], "laptop", TTL, now)).toBe("laptop");
  });

  it("a stale on-console plus a fresh on-console picks the fresh one", () => {
    const rows = [
      row({ machine: "studio", onConsole: true, heartbeat: new Date(now - 90_000) }),
      row({ machine: "laptop", onConsole: true, heartbeat: new Date(now - 1_000) }),
    ];
    expect(resolveLiveConsole(rows, "studio", TTL, now)).toBe("laptop");
  });
});

// ── PG-gated: upsertSelfPresence writes a server-authoritative heartbeat ──────

import { hasLivePg as hasPg } from "../testing/live-pg";
const FP_SCHEMA = `nx_fp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const FP_DDL = `
  CREATE TABLE "fleet_presence" (
    "machine" text PRIMARY KEY NOT NULL,
    "on_console" boolean DEFAULT false NOT NULL,
    "mac_active" boolean,
    "mac_locked" boolean,
    "heartbeat" timestamp NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
`;

describe.skipIf(!hasPg)("upsertSelfPresence (requires live PG)", () => {
  let adminSql: ReturnType<typeof createDb>["client"];
  let scopedDb: Db;
  let scopedClient: ReturnType<typeof createDb>["client"];

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminSql = adminHandle.client;
    await adminSql.unsafe(`CREATE SCHEMA "${FP_SCHEMA}"`);
    await adminSql.unsafe(`SET search_path TO "${FP_SCHEMA}", public`);
    await adminSql.unsafe(FP_DDL);

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${FP_SCHEMA}",public` },
    });
    scopedDb = scopedHandle.db;
    scopedClient = scopedHandle.client;
  });

  afterAll(async () => {
    await scopedClient?.end({ timeout: 5 });
    await adminSql?.unsafe(`DROP SCHEMA IF EXISTS "${FP_SCHEMA}" CASCADE`);
    await adminSql?.end({ timeout: 5 });
  });

  it("inserts a row whose heartbeat is the DB now() (not a JS clock)", async () => {
    await upsertSelfPresence(scopedDb, "studio", {
      onConsole: true,
      macActive: true,
      macLocked: false,
    });

    const rows = (await scopedClient.unsafe(
      `SELECT machine, on_console, mac_active, mac_locked,
              heartbeat, now() AS db_now
       FROM "${FP_SCHEMA}".fleet_presence WHERE machine = 'studio'`,
    )) as unknown as Array<{
      machine: string;
      on_console: boolean;
      mac_active: boolean;
      mac_locked: boolean;
      heartbeat: Date;
      db_now: Date;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.on_console).toBe(true);
    expect(rows[0]!.mac_active).toBe(true);
    expect(rows[0]!.mac_locked).toBe(false);
    // Heartbeat is server-authoritative: within a few seconds of the DB clock.
    const skew = Math.abs(
      new Date(rows[0]!.db_now).getTime() - new Date(rows[0]!.heartbeat).getTime(),
    );
    expect(skew).toBeLessThan(5_000);
  });

  it("upserts the same machine in place and refreshes the heartbeat", async () => {
    await upsertSelfPresence(scopedDb, "studio", { onConsole: false });
    const first = (await scopedClient.unsafe(
      `SELECT heartbeat FROM "${FP_SCHEMA}".fleet_presence WHERE machine = 'studio'`,
    )) as unknown as Array<{ heartbeat: Date }>;

    await new Promise((r) => setTimeout(r, 1100));
    await upsertSelfPresence(scopedDb, "studio", { onConsole: false });
    const second = (await scopedClient.unsafe(
      `SELECT COUNT(*)::int AS n, MAX(heartbeat) AS heartbeat
       FROM "${FP_SCHEMA}".fleet_presence WHERE machine = 'studio'`,
    )) as unknown as Array<{ n: number; heartbeat: Date }>;

    expect(second[0]!.n).toBe(1); // upsert in place, not a second row
    expect(new Date(second[0]!.heartbeat).getTime()).toBeGreaterThan(
      new Date(first[0]!.heartbeat).getTime(),
    );
  });
});
