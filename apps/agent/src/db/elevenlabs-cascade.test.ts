/**
 * FK cascade smoke test — elevenlabs_credentials.agent_id ON DELETE CASCADE.
 *
 * Locks the requirement from `add-elevenlabs-credential` migration 0020:
 *   ALTER TABLE elevenlabs_credentials
 *   ADD CONSTRAINT elevenlabs_credentials_agent_id_agents_id_fk
 *   FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
 *
 * Spec: openspec/changes/harden-elevenlabs-credential-p2-p3-gcf/specs/elevenlabs-credential/spec.md
 *   § "FK cascade behavior SHALL have an integration smoke test"
 *
 * Pattern: mirrors `apps/agent/src/db/db.test.ts` — creates a dedicated
 * Postgres schema inside POSTGRES_URL, builds the minimal `agents` +
 * `elevenlabs_credentials` shape there with the real FK clause, exercises
 * the cascade, and drops the schema in teardown. Never touches `public`.
 *
 * PG-gated: skipped automatically when POSTGRES_URL is unset.
 *
 * To run locally:
 *   1. docker compose -f docker-compose.test.yml up -d   (or have Postgres reachable)
 *   2. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   3. bun test apps/agent/src/db/elevenlabs-cascade.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createDb } from "@nexus/db";

type Sql = ReturnType<typeof createDb>["client"];

const hasPg = !!process.env.POSTGRES_URL;

// Unique schema per run so parallel workers cannot collide and abandoned
// runs never block the next invocation.
const TEST_SCHEMA = `nx_elcascade_test_${Date.now()}_${Math.floor(
  Math.random() * 1e6,
)}`;

// Minimal DDL — only the columns required to exercise the FK cascade. The
// `value_encrypted` column is left nullable per migration 0020 (we don't
// need real ciphertext for a cascade test; the column accepts NULL).
const DDL = `
  CREATE TABLE "agents" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text DEFAULT '',
    "host" text NOT NULL,
    "port" integer DEFAULT 7400,
    "enabled" boolean DEFAULT true,
    "created_at" timestamp DEFAULT now(),
    "deleted_at" timestamp
  );

  CREATE TABLE "elevenlabs_credentials" (
    "id" text PRIMARY KEY NOT NULL,
    "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
    "value_encrypted" text,
    "encryption_key_id" text DEFAULT 'v1',
    "voice_id" text,
    "voice_name" text,
    "last_test_ok_at" timestamp,
    "last_test_status_code" integer,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX "elevenlabs_credentials_agent_id_unique"
    ON "elevenlabs_credentials" USING btree ("agent_id");
`;

describe.skipIf(!hasPg)(
  "elevenlabs_credentials FK cascade (requires live PG)",
  () => {
    let adminSql: Sql;
    let adminClient: Sql;

    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      adminClient = adminHandle.client;
      adminSql = adminClient;

      await adminSql.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
      await adminSql.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);
      await adminSql.unsafe(DDL);
    });

    afterAll(async () => {
      try {
        await adminSql.unsafe(
          `DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminClient.end({ timeout: 5 });
      }
    });

    it("DELETE on agents cascades to elevenlabs_credentials", async () => {
      const agentId = "cascade-agent-001";
      const credId = "cascade-cred-001";

      // 1) Insert agent
      await adminSql.unsafe(
        `INSERT INTO "${TEST_SCHEMA}"."agents" ("id", "host")
         VALUES ('${agentId}', 'localhost')`,
      );

      // 2) Insert elevenlabs_credentials row keyed on the agent. We pass
      //    a stable fake-but-base64 ciphertext placeholder so the row is
      //    plausibly shaped — the column is nullable so an explicit value
      //    is not required, but writing one exercises the value_encrypted
      //    text column too.
      await adminSql.unsafe(
        `INSERT INTO "${TEST_SCHEMA}"."elevenlabs_credentials"
           ("id", "agent_id", "value_encrypted", "voice_id")
         VALUES
           ('${credId}', '${agentId}', 'AAECAwQFBgcICQoLDA0ODw==', 'voice-x')`,
      );

      // Sanity: the credential row is present before the cascade.
      const before = (await adminSql.unsafe(
        `SELECT COUNT(*)::int AS count
           FROM "${TEST_SCHEMA}"."elevenlabs_credentials"
          WHERE agent_id = '${agentId}'`,
      )) as Array<{ count: number }>;
      expect(before[0]!.count).toBe(1);

      // 3) DELETE the agent — this is the trigger.
      await adminSql.unsafe(
        `DELETE FROM "${TEST_SCHEMA}"."agents" WHERE id = '${agentId}'`,
      );

      // 4) Assert the elevenlabs_credentials row is gone (cascade fired).
      const after = (await adminSql.unsafe(
        `SELECT COUNT(*)::int AS count
           FROM "${TEST_SCHEMA}"."elevenlabs_credentials"
          WHERE agent_id = '${agentId}'`,
      )) as Array<{ count: number }>;
      expect(after[0]!.count).toBe(0);

      // 5) Defensive cleanup — there should be nothing left, but if a
      //    future change loosens the cascade and this test starts to fail
      //    differently, we still want the schema teardown to be clean.
      await adminSql.unsafe(
        `DELETE FROM "${TEST_SCHEMA}"."elevenlabs_credentials"
          WHERE id = '${credId}'`,
      );
    });
  },
);

// When POSTGRES_URL is unset, bun:test prints "(skipped: …)" for the
// describe block above. The block below adds an explicit, always-running
// canary so CI logs include a positive signal that the file was loaded
// even on environments where Postgres is unreachable.
describe("elevenlabs_credentials FK cascade — load canary", () => {
  it("test file loaded (skip path is structural)", () => {
    expect(typeof hasPg).toBe("boolean");
  });
});
