/**
 * Route tests for GET /credentials/:id/usage-history (requires live PG).
 *
 * Spec: credential-usage-history (task 4.3)
 *
 * Drives the real handleCredentialUsageHistory query against a scratch schema
 * (see reaper-persistence.test.ts § scratch-schema isolation): each run creates
 * a unique schema under POSTGRES_URL, builds a minimal credentials +
 * credential_polls shape there, pins every pooled connection to it via
 * connection.search_path, and drops the schema in teardown. Skips cleanly when
 * live PG is unavailable.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createDb, credentialPolls } from "@nexus/db";
import type { Db } from "@nexus/db";
import { handleCredentialUsageHistory } from "./handlers-health-usage";
import { hasLivePg as hasPg } from "../../testing/live-pg";

type Sql = ReturnType<typeof createDb>["client"];

interface HistoryEnvelope {
  points: Array<{ polledAt: string; used: number; limit: number }>;
}

const SCHEMA = `nx_usage_hist_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const DDL = `
  CREATE TABLE "credentials" (
    "id" text PRIMARY KEY,
    "name" text NOT NULL,
    "type" text NOT NULL,
    "status" text NOT NULL DEFAULT 'available',
    "rate_limit_count" integer NOT NULL DEFAULT 0,
    "fingerprint" text NOT NULL DEFAULT '',
    "is_primary" boolean NOT NULL DEFAULT false,
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE "credential_polls" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "credential_id" text NOT NULL REFERENCES "credentials"("id") ON DELETE CASCADE,
    "fingerprint" text NOT NULL,
    "usage_5h_used" integer,
    "usage_5h_limit" integer,
    "usage_7d_used" integer,
    "usage_7d_limit" integer,
    "usage_5h_reset_at" timestamptz,
    "usage_7d_reset_at" timestamptz,
    "polled_at" timestamptz NOT NULL
  );
`;

const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000);

/** Build a Request for the handler; window/sinceHours are optional. */
function historyReq(id: string, query = ""): Request {
  return new Request(`http://localhost/credentials/${id}/usage-history${query}`);
}

describe.skipIf(!hasPg)(
  "handleCredentialUsageHistory (requires live PG)",
  () => {
    let adminClient: Sql;
    let scopedClient: Sql;
    let db: Db;

    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      adminClient = adminHandle.client;

      await adminClient.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
      await adminClient.unsafe(`SET search_path TO "${SCHEMA}", public`);
      await adminClient.unsafe(DDL);

      const scopedHandle = createDb(url, {
        connection: { search_path: `"${SCHEMA}",public` },
      });
      scopedClient = scopedHandle.client;
      db = scopedHandle.db;

      // FK-parent seed via raw SQL — drizzle's insert would emit JS-default
      // columns (encryption_key_id, etc.) absent from the minimal DDL above.
      await scopedClient.unsafe(
        `INSERT INTO "credentials" (id, name, type, fingerprint, is_primary)
         VALUES ('cred-1', 'primary', 'anthropic', 'fp-1', true)`,
      );

      // Three polls, inserted out of order, within the default 24h window.
      // Distinct 5h vs 7d values so the window column-selection is observable.
      await db.insert(credentialPolls).values([
        {
          credentialId: "cred-1",
          fingerprint: "fp-1",
          usage5hUsed: 20,
          usage5hLimit: 50,
          usage7dUsed: 200,
          usage7dLimit: 1000,
          polledAt: hoursAgo(2),
        },
        {
          credentialId: "cred-1",
          fingerprint: "fp-1",
          usage5hUsed: 10,
          usage5hLimit: 50,
          usage7dUsed: 100,
          usage7dLimit: 1000,
          polledAt: hoursAgo(6),
        },
        {
          credentialId: "cred-1",
          fingerprint: "fp-1",
          usage5hUsed: 30,
          usage5hLimit: 50,
          usage7dUsed: 300,
          usage7dLimit: 1000,
          polledAt: hoursAgo(1),
        },
      ]);
    });

    afterAll(async () => {
      try {
        await scopedClient.end({ timeout: 5 });
      } finally {
        try {
          await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        } finally {
          await adminClient.end({ timeout: 5 });
        }
      }
    });

    it("returns oldest-first points for a seeded id (default window=5h)", async () => {
      const res = await handleCredentialUsageHistory(db, "cred-1", historyReq("cred-1"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryEnvelope;

      expect(body.points).toHaveLength(3);
      // Ordered ascending by polledAt (6h, 2h, 1h ago).
      const times = body.points.map((p) => Date.parse(p.polledAt));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      // Default window=5h → 5h used column.
      expect(body.points.map((p) => p.used)).toEqual([10, 20, 30]);
      expect(body.points[0]!.limit).toBe(50);
    });

    it("selects the 7-day columns when window=7d", async () => {
      const res = await handleCredentialUsageHistory(
        db,
        "cred-1",
        historyReq("cred-1", "?window=7d"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryEnvelope;

      expect(body.points).toHaveLength(3);
      expect(body.points.map((p) => p.used)).toEqual([100, 200, 300]);
      expect(body.points[0]!.limit).toBe(1000);
    });

    it("returns { points: [] } + 200 for an unknown id", async () => {
      const res = await handleCredentialUsageHistory(
        db,
        "does-not-exist",
        historyReq("does-not-exist"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryEnvelope;
      expect(body.points).toEqual([]);
    });
  },
);
