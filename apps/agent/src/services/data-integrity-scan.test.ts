/**
 * data-integrity-scan unit tests (nexus-self-healing-infra, db-integrity
 * spec, task 3.5).
 *
 * `scanProjectDuplicates()` runs a real Drizzle query (`SELECT ... GROUP BY
 * ... HAVING COUNT(*) > 1`) against the `projects` table, so — like this
 * package's other schema-shaped tests (`database.test.ts`,
 * `migration-0010-orphans.test.ts`) — proving detection needs a real
 * Postgres. This suite mirrors `database.test.ts`'s isolated-schema
 * pattern: each case carves out its own scratch Postgres schema, seeds a
 * stripped-down `projects` (+ `cron_runs`, for the full
 * `runAndPersistDataIntegrityScan` cases) table, runs the assertions, and
 * drops the schema in teardown. POSTGRES_URL-gated so the suite skips
 * cleanly when no live PG is available — see `../testing/live-pg.ts`.
 *
 * Deliberately does NOT create `projects_name_null_remote_unique` (the
 * migration-0049 partial unique index that now prevents new no-remote-URL
 * duplicates in production) — the whole point of the "seeded duplicates"
 * fixture is inserting rows that index would otherwise reject, to prove
 * the REGRESSION DETECTOR itself still works if that constraint were ever
 * dropped or bypassed by a new code path (exactly the scenario this job's
 * own header doc calls out).
 *
 * To run (mirrors database.test.ts's header):
 *   docker compose -f docker-compose.test.yml up -d
 *   export NEXUS_PG_TESTS=1
 *   export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
 *   bun test apps/agent/src/services/data-integrity-scan.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import {
  scanProjectDuplicates,
  runAndPersistDataIntegrityScan,
  __resetDataIntegrityNotifyForTests,
} from "./data-integrity-scan";
import { lifecycleBus, type LifecycleEnvelope } from "./lifecycle-bus";
import { hasLivePg as hasPg } from "../testing/live-pg";

type Sql = ReturnType<typeof createDb>["client"];

function projectsAndCronRunsDdl(): string {
  return `
    CREATE TABLE "projects" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "name" text NOT NULL,
      "git_remote_url" text,
      "primary_agent_id" text NOT NULL DEFAULT 'test-agent'
    );
    CREATE TABLE "cron_runs" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "timestamp" timestamp NOT NULL,
      "job" text NOT NULL,
      "status" text NOT NULL,
      "details" jsonb,
      "metrics" jsonb
    );
  `;
}

async function buildIsolatedDb(
  schemaName: string,
): Promise<{ db: Db; adminClient: Sql; scopedClient: Sql }> {
  const url = process.env.POSTGRES_URL!;
  const adminHandle = createDb(url);
  const adminClient = adminHandle.client;

  await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminClient.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await adminClient.unsafe(`SET search_path TO "${schemaName}", public`);
  await adminClient.unsafe(projectsAndCronRunsDdl());

  const scopedHandle = createDb(url, {
    connection: { search_path: `"${schemaName}",public` },
  });
  return { db: scopedHandle.db, adminClient, scopedClient: scopedHandle.client };
}

async function dropIsolatedDb(
  schemaName: string,
  adminClient: Sql,
  scopedClient: Sql,
): Promise<void> {
  try {
    await scopedClient.end({ timeout: 5 });
  } finally {
    try {
      await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await adminClient.end({ timeout: 5 });
    }
  }
}

function captureNotifications(): {
  fired: LifecycleEnvelope<"NotificationFired">[];
  detach: () => void;
} {
  const fired: LifecycleEnvelope<"NotificationFired">[] = [];
  const handler = (env: LifecycleEnvelope<"NotificationFired">): void => {
    fired.push(env);
  };
  lifecycleBus.on("NotificationFired", handler);
  return { fired, detach: () => lifecycleBus.off("NotificationFired", handler) };
}

// ─── 1. Seeded fixture with duplicates — detection fires, zero writes ──────

describe.skipIf(!hasPg)("scanProjectDuplicates — seeded duplicate fixture", () => {
  const schemaName = `nx_dupscan_dup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let db: Db;
  let adminClient: Sql;
  let scopedClient: Sql;

  beforeAll(async () => {
    ({ db, adminClient, scopedClient } = await buildIsolatedDb(schemaName));
    await scopedClient.unsafe(`
      INSERT INTO "projects" ("name", "git_remote_url") VALUES
        ('dup-project', NULL),
        ('dup-project', NULL),
        ('unique-project', NULL),
        ('shared-name-but-has-remote', 'git@github.com:x/a.git'),
        ('shared-name-but-has-remote', 'git@github.com:x/b.git')
    `);
  });

  afterAll(async () => {
    await dropIsolatedDb(schemaName, adminClient, scopedClient);
  });

  it("detects exactly the (name, NULL git_remote_url) duplicate group and ignores singletons + remote-qualified names", async () => {
    const findings = await scanProjectDuplicates(db);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({ name: "dup-project", duplicateCount: 2 });
  });

  it("performs zero writes — the projects row count is unchanged after scanning", async () => {
    const before = await scopedClient`SELECT COUNT(*)::int AS n FROM "projects"`;
    await scanProjectDuplicates(db);
    const after = await scopedClient`SELECT COUNT(*)::int AS n FROM "projects"`;

    expect(after[0]?.n).toBe(before[0]?.n);
    expect(after[0]?.n).toBe(5);
  });

  describe("runAndPersistDataIntegrityScan — fires a notification", () => {
    beforeEach(() => {
      __resetDataIntegrityNotifyForTests();
    });

    it("emits both desktop + tts NotificationFired events when duplicates are found", async () => {
      const { fired, detach } = captureNotifications();
      try {
        const result = await runAndPersistDataIntegrityScan({
          db,
          timestamp: new Date("2026-07-16T00:00:00Z"),
        });

        expect(result.status).toBe("success");
        expect(result.findings).toEqual([{ name: "dup-project", duplicateCount: 2 }]);
        expect(fired).toHaveLength(2);
        expect(fired.map((f) => f.payload.channel).sort()).toEqual(["desktop", "tts"]);
        expect(fired[0]?.payload.title).toBe("Data integrity WARNING");
        expect(fired[0]?.payload.body).toContain("dup-project");
      } finally {
        detach();
      }
    });
  });
});

// ─── 2. Clean fixture — no duplicates, no notification ──────────────────────

describe.skipIf(!hasPg)("scanProjectDuplicates — clean fixture", () => {
  const schemaName = `nx_dupscan_clean_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let db: Db;
  let adminClient: Sql;
  let scopedClient: Sql;

  beforeAll(async () => {
    ({ db, adminClient, scopedClient } = await buildIsolatedDb(schemaName));
    await scopedClient.unsafe(`
      INSERT INTO "projects" ("name", "git_remote_url") VALUES
        ('solo-project-a', NULL),
        ('solo-project-b', NULL),
        ('has-a-remote', 'git@github.com:x/y.git')
    `);
  });

  afterAll(async () => {
    await dropIsolatedDb(schemaName, adminClient, scopedClient);
  });

  it("returns zero findings", async () => {
    const findings = await scanProjectDuplicates(db);
    expect(findings).toEqual([]);
  });

  describe("runAndPersistDataIntegrityScan — no notification", () => {
    beforeEach(() => {
      __resetDataIntegrityNotifyForTests();
    });

    it("persists a success run with zero findings and fires no notification", async () => {
      const { fired, detach } = captureNotifications();
      try {
        const result = await runAndPersistDataIntegrityScan({
          db,
          timestamp: new Date("2026-07-16T00:00:00Z"),
        });

        expect(result.status).toBe("success");
        expect(result.findings).toEqual([]);
        expect(fired).toHaveLength(0);
      } finally {
        detach();
      }
    });
  });
});
