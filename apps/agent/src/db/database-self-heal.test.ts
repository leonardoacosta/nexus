/**
 * verifySchema() self-heal unit tests (nexus-self-healing-infra, task 3.2).
 *
 * Complements this directory's `database.test.ts` (live-PG-gated, proves the
 * real schema probe against actual tables) with a live-PG-FREE unit test of
 * the self-heal orchestration added in task 2.3: does `verifySchema()` call
 * `selfHealingMigrate()` exactly once when tables are missing, proceed
 * without throwing when the self-heal attempt actually fixes it, and still
 * throw `SchemaIncompleteError` when tables remain missing after the
 * attempt — or when `selfHealingMigrate()` itself throws?
 *
 * Per the E2E-batch task note ("follow the existing skip-gating convention
 * in that file for your new test rather than requiring a live DB
 * unconditionally"), this suite avoids requiring Postgres at all rather than
 * gating on it: `findMissingTables()` issues exactly `REQUIRED_TABLES.length`
 * sequential `db.execute()` calls per invocation (one per required table, in
 * declaration order), so a fake `Db` whose `.execute()` is a call-counting
 * stub can answer the "first probe" vs. "re-probe after self-heal" question
 * deterministically with zero DB involvement — a stronger contract than a
 * live integration test for this specific orchestration question (call
 * count + control flow), which doesn't depend on real Postgres semantics.
 *
 * `selfHealingMigrate` itself is swapped via `mock.module("@nexus/db", ...)`
 * — the sanctioned pattern for this package per
 * `apps/agent/src/testing/mock-nexus-db.ts`'s header doc: spread the real
 * barrel (`{ ...realDb, selfHealingMigrate: <mock> }`), never a partial
 * override, so every other `@nexus/db` export (tables, drizzle helpers,
 * `createDb`) stays real for any other suite loaded in the same process. No
 * other apps/agent suite calls the REAL `selfHealingMigrate` through this
 * package specifier — `packages/db/src/migrate.test.ts` imports it from the
 * sibling relative path `./migrate`, a different module specifier entirely,
 * so it is unaffected by this file's mock.
 *
 * Per that same mock-nexus-db.ts doc, the mock MUST be installed and the SUT
 * loaded via a dynamic `import()` AFTER the `mock.module()` call — hence the
 * dedicated file (rather than adding to `database.test.ts`, whose top-of-file
 * STATIC import of `./database` would already resolve the real `@nexus/db`
 * binding before any in-file `mock.module()` call could run).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDb from "@nexus/db";
import type { Db } from "@nexus/db";

// Reassigned per-test; the mock.module factory closes over this binding so
// each test controls selfHealingMigrate's behavior independently.
let selfHealMigrateMock = mock(async (_client: unknown): Promise<void> => {});

mock.module("@nexus/db", () => ({
  ...realDb,
  selfHealingMigrate: (client: unknown) => selfHealMigrateMock(client),
}));

const { verifySchema, SchemaIncompleteError, REQUIRED_TABLES } = await import("./database");

/**
 * Build a fake `Db` whose `.execute()` answers the REQUIRED_TABLES probe
 * loop deterministically: `missingOnFirstProbe`/`missingOnSecondProbe` name
 * which tables report as missing (`oid: null`) on the 1st vs. 2nd
 * `findMissingTables()` invocation (verifySchema calls it once up front,
 * and — only on a SchemaIncompleteError condition — once more after the
 * selfHealingMigrate attempt).
 */
function makeFakeDb(
  missingOnFirstProbe: readonly string[],
  missingOnSecondProbe: readonly string[],
): { db: Db; executeMock: ReturnType<typeof mock> } {
  const tableCount = REQUIRED_TABLES.length;
  let callIndex = 0;
  const executeMock = mock(async () => {
    const probeNumber = Math.floor(callIndex / tableCount);
    const table = REQUIRED_TABLES[callIndex % tableCount];
    callIndex++;
    const missingSet = probeNumber === 0 ? missingOnFirstProbe : missingOnSecondProbe;
    const oid = missingSet.includes(table as string) ? null : "16400";
    return [{ oid }];
  });
  const db = { execute: executeMock } as unknown as Db;
  return { db, executeMock };
}

describe("verifySchema self-heal orchestration", () => {
  const originalSkipFlag = process.env.NEXUS_SKIP_SCHEMA_CHECK;

  beforeEach(() => {
    delete process.env.NEXUS_SKIP_SCHEMA_CHECK;
    selfHealMigrateMock = mock(async (_client: unknown): Promise<void> => {});
  });

  afterEach(() => {
    if (originalSkipFlag === undefined) {
      delete process.env.NEXUS_SKIP_SCHEMA_CHECK;
    } else {
      process.env.NEXUS_SKIP_SCHEMA_CHECK = originalSkipFlag;
    }
  });

  it("never calls selfHealingMigrate when no tables are missing on the first probe", async () => {
    const { db } = makeFakeDb([], []);

    await expect(verifySchema(db)).resolves.toBeUndefined();
    expect(selfHealMigrateMock).toHaveBeenCalledTimes(0);
  });

  it("calls selfHealingMigrate exactly once and resolves without throwing when the self-heal attempt fixes the missing table", async () => {
    const lastTable = REQUIRED_TABLES[REQUIRED_TABLES.length - 1] as string;
    const { db } = makeFakeDb([lastTable], []);

    await expect(verifySchema(db)).resolves.toBeUndefined();
    expect(selfHealMigrateMock).toHaveBeenCalledTimes(1);
  });

  it("calls selfHealingMigrate exactly once and re-throws SchemaIncompleteError naming the table still missing after the attempt", async () => {
    const { db } = makeFakeDb(["notifications"], ["notifications"]);

    let caught: unknown;
    try {
      await verifySchema(db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SchemaIncompleteError);
    expect((caught as InstanceType<typeof SchemaIncompleteError>).missingTables).toContain(
      "notifications",
    );
    expect(selfHealMigrateMock).toHaveBeenCalledTimes(1);
  });

  it("calls selfHealingMigrate exactly once and still throws SchemaIncompleteError (not the self-heal's own error) when selfHealingMigrate itself throws", async () => {
    selfHealMigrateMock = mock(async (): Promise<void> => {
      throw new Error("selfHealingMigrate boom — e.g. broken migration or connection failure");
    });
    const { db } = makeFakeDb(["sessions"], ["sessions"]);

    let caught: unknown;
    try {
      await verifySchema(db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SchemaIncompleteError);
    expect((caught as InstanceType<typeof SchemaIncompleteError>).missingTables).toContain(
      "sessions",
    );
    expect(selfHealMigrateMock).toHaveBeenCalledTimes(1);
  });
});
