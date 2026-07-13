/**
 * E2E [4.1] (nx-urgv): file watcher auto-imports a new credential file.
 *
 * Regression guard for `startCredentialWatcher()`'s LIVE `fs.watch` event
 * loop (apps/agent/src/credentials/credential-watcher.ts). The pre-existing
 * unit suite (credential-watcher.test.ts) only covers `runInitialScan` — the
 * boot-time pass over files that already exist. Nothing exercised the
 * post-boot path: a new `acct-*.json` file dropped into the credential
 * directory WHILE the watcher is running.
 *
 * What the test does
 * -------------------
 *   1. Instantiate a real `CredentialPool` against real Postgres (test DB
 *      at port 5433 — never dev/prod).
 *   2. Start `startCredentialWatcher(pool, { credDir })` against an isolated
 *      temp directory — `credDir` is already an overridable option (no
 *      production code change was needed for this test).
 *   3. After the watcher's initial scan + fs.watch loop are up, write a
 *      brand-new valid credential file into that directory.
 *   4. Assert the debounced fs.watch handler fires `pool.add()` and a real
 *      row lands in the `credentials` table, decryptable back to the
 *      original plaintext.
 *   5. Stop the watcher (AbortController) and clean up the temp dir + row.
 *
 * Skip conditions
 * ---------------
 *   - `POSTGRES_URL` missing, or
 *   - `POSTGRES_URL` does NOT point at `nexus_test` (refuses to clobber
 *     dev/prod data — same sentinel as projects-pagination.test.ts).
 *
 * To run locally
 * --------------
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test \
 *      bun test tests/e2e/credential-watcher.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Skip-if-missing preflight ──────────────────────────────────────────────
//
// Gate on the *test* DB specifically. If POSTGRES_URL points at a dev DB this
// test would insert real-looking credential rows there, so require an opt-in
// sentinel (the "nexus_test" database name provisioned by docker-compose.test.yml).

const POSTGRES_URL = process.env.POSTGRES_URL;
const IS_TEST_DB = !!POSTGRES_URL && /\/nexus_test(?:[?#]|$)/.test(POSTGRES_URL);

if (!IS_TEST_DB) {
  const reason = POSTGRES_URL
    ? "POSTGRES_URL does not point at the nexus_test database (refusing to clobber dev/prod data)"
    : "POSTGRES_URL not set";
  describe.skip(
    `E2E [4.1]: file watcher auto-imports new credential (skipped — ${reason})`,
    () => {
      it("skipped", () => {
        /* no-op — visible in runner as skipped suite */
      });
    },
  );
} else {
  // ── Real-DB path ─────────────────────────────────────────────────────────

  const { createDb, credentials, eq } = await import("@nexus/db");

  const dbHandle = createDb(POSTGRES_URL);
  const db = dbHandle.db;
  const pg = dbHandle.client;

  const { CredentialPool } = await import(
    "../../apps/agent/src/credentials/pool"
  );
  const { startCredentialWatcher } = await import(
    "../../apps/agent/src/credentials/credential-watcher"
  );
  const { TEST_KEY, computeCredentialFingerprint } = await import(
    "../../apps/agent/src/credentials/credentials.helpers"
  );
  const { decrypt } = await import(
    "../../apps/agent/src/credentials/encryption"
  );

  // processCredentialFile() derives the DB `name` column as
  // basename(filename, ".json") -- the "acct-" prefix is retained verbatim
  // (see credential-watcher.test.ts's runInitialScan assertions), so the
  // lookup key below must include it too.
  const CRED_FILE_STEM = "e2e-watch-nx-urgv";
  const CRED_DB_NAME = `acct-${CRED_FILE_STEM}`;

  const validCredential = JSON.stringify({
    claudeAiOauth: {
      refreshToken: "rt-e2e-watch-deadbeef-0001",
      accessToken: "at-e2e-watch-deadbeef-0001",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
  });

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pingDb(): Promise<boolean> {
    try {
      await pg`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async function clearFixtureRows(): Promise<void> {
    await db.delete(credentials).where(eq(credentials.name, CRED_DB_NAME));
  }

  let dbReachable = false;
  let tempDir = "";
  let watcherController: AbortController | null = null;

  beforeAll(async () => {
    dbReachable = await pingDb();
    if (!dbReachable) return;

    await clearFixtureRows();
    tempDir = await mkdtemp(join(tmpdir(), "nx-urgv-watch-"));
  });

  afterAll(async () => {
    watcherController?.abort();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    if (!dbReachable) return;
    try {
      await clearFixtureRows();
    } finally {
      await pg.end({ timeout: 2 });
    }
  });

  describe("E2E [4.1]: file watcher auto-imports new credential", () => {
    it("agent database is reachable (pre-flight)", () => {
      expect(dbReachable).toBe(true);
    });

    it("writing a new acct-*.json while the watcher is running inserts a real DB row via pool.add()", async () => {
      const pool = new CredentialPool(db, { encryptionKey: TEST_KEY });

      // Start the watcher against the isolated temp dir. The dir is empty at
      // this point, so the initial scan (runInitialScan) is a fast no-op —
      // give it a moment to finish and for the live fs.watch loop to attach
      // before writing the file, so the event is caught by the LIVE path
      // (not accidentally raced into the initial scan).
      watcherController = startCredentialWatcher(pool, { credDir: tempDir });
      await delay(300);

      // Write a brand-new credential file AFTER the watcher is live.
      await writeFile(
        join(tempDir, `acct-${CRED_FILE_STEM}.json`),
        validCredential,
      );

      // fs.watch debounces per-file at DEBOUNCE_MS=200ms internally; wait
      // comfortably past that plus processing time (DB insert + encryption).
      await delay(800);

      const rows = await db
        .select()
        .from(credentials)
        .where(eq(credentials.name, CRED_DB_NAME));

      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.type).toBe("oauth");
      expect(row.fingerprint).toBe(
        computeCredentialFingerprint(validCredential),
      );

      // Decrypt back to the original plaintext to prove the LIVE watcher
      // path (not the initial scan) actually ran the file through
      // processCredentialFile() -> pool.add() with the real content.
      expect(row.valueEncrypted).toBeTruthy();
      const decrypted = decrypt(row.valueEncrypted!, TEST_KEY);
      expect(decrypted).toBe(validCredential);
    });
  });
}
