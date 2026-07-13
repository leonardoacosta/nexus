/**
 * active-credential-watcher unit tests.
 *
 * Spec: bd:nx-44mby. Rotation-in-place behavior: nx-lp8v/nx-m5q6.
 *
 * The watcher's job is to track `~/.claude/.credentials.json` — the live
 * credential Claude Code maintains and refreshes continuously. Claude Code
 * performs FULL refresh-token rotation (each grant returns a new
 * refreshToken alongside the new accessToken), so the live file's
 * fingerprint changes periodically.
 *
 * Pre-nx-44mby the watcher only computed the live fingerprint and matched
 * it against pool rows. When the rotation happened, no pool row matched
 * (the OLD fingerprint is the only one stored), and the snapshot
 * fingerprint went to null — leaving every downstream surface
 * (usage-poller, probeIdentity, dashboard active-account indicator)
 * stuck on the dead pre-rotation tokens.
 *
 * A second bug (found investigating credential-usage-poller's 100% failure
 * rate) was that even the rotation-import fix above still gated `pool.add()`
 * behind "fingerprint not already in the pool". Because
 * `fingerprint = SHA256(refreshToken)`, an ACCESS-token-only refresh (which
 * Claude Code performs far more often than a full refresh-token rotation)
 * leaves the fingerprint unchanged — so a credential's stale access token
 * was written once on import and never updated again. The fix called
 * `pool.add()` unconditionally on every observation, relying on it being
 * idempotent (update-in-place on a fingerprint+name match).
 *
 * A THIRD bug (nx-lp8v/nx-m5q6: `credentials` table growing to thousands of
 * rows with only one ever `isActive`): unconditional `pool.add()` on a
 * REAL rotation (fingerprint actually changes) computes a fingerprint-derived
 * name (`acct-<fp8>`), which never matches the old row's name either — so
 * `add()` fell into its insert branch and minted a brand-new `isPrimary=true`
 * row every single rotation, permanently orphaning the previous one. The fix
 * below detects a rotation (new fingerprint != previously observed
 * fingerprint) and, when the old fingerprint still has a pool row, calls
 * `pool.updateSecret()` to update that row's token material in place instead
 * of inserting a new one. `pool.add()` remains the fallback for cold starts
 * and for a rotation whose previous row can no longer be found.
 *
 * Tests below validate the import-on-rotation contract, the rotate-in-place
 * contract, and the always-mirror-on-unchanged-fingerprint contract by
 * injecting a fake pool and overriding the credentials file path via the
 * test seam `__testing.runRefresh(pool, credentialPath)`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testing as activeTesting,
  startActiveCredentialWatcher,
} from "./active-credential-watcher";
import { computeCredentialFingerprint } from "./credentials.helpers";

interface FakePoolCall {
  method: "add" | "list" | "updateSecret";
  arg?: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  };
  updateSecretArg?: {
    id: string;
    newPlaintextBlob: object;
    newExpiresAt: Date;
  };
}

interface FakePool {
  add(input: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  }): Promise<"inserted" | "updated">;
  list(): Promise<Array<{ id: string; fingerprint: string | null }>>;
  updateSecret(
    id: string,
    newPlaintextBlob: object,
    newExpiresAt: Date,
  ): Promise<void>;
  calls: FakePoolCall[];
  /** Rows the fake pool returns from list(). Tests mutate this between calls. */
  rows: Array<{ id: string; fingerprint: string | null }>;
}

function createFakePool(initialRows: FakePool["rows"] = []): FakePool {
  const pool: FakePool = {
    calls: [],
    rows: [...initialRows],
    async add(input) {
      pool.calls.push({
        method: "add",
        arg: {
          id: input.id,
          name: input.name,
          type: input.type,
          value_plaintext: input.value_plaintext,
        },
      });
      // Mirror production CredentialPool.add()'s re-import guard
      // (pool-core.ts ~line 213-266): a row whose fingerprint already
      // matches is the same pool file re-imported (name is deterministically
      // derived from the fingerprint at every callsite in this file, so a
      // fingerprint match implies a name match too) — update it IN PLACE
      // (same id, no new row) instead of inserting a duplicate. Only a miss
      // falls through to the insert branch. Getting this wrong (always
      // pushing) is what caused nx-dwoqv: a cold-start add() whose live
      // fingerprint happens to match an already-seeded row silently minted a
      // second row that a later updateSecret() call never touched.
      const fp = computeCredentialFingerprint(input.value_plaintext);
      const existing = pool.rows.find((r) => r.fingerprint === fp);
      if (existing) {
        existing.fingerprint = fp;
        return "updated";
      }
      pool.rows.push({ id: input.id, fingerprint: fp });
      return "inserted";
    },
    async list() {
      pool.calls.push({ method: "list" });
      return pool.rows.map((r) => ({ ...r }));
    },
    async updateSecret(id, newPlaintextBlob, newExpiresAt) {
      pool.calls.push({
        method: "updateSecret",
        updateSecretArg: { id, newPlaintextBlob, newExpiresAt },
      });
      // Mirror the production updateSecret(): the row's fingerprint changes
      // in place, same id, no new row.
      const plaintext = JSON.stringify(newPlaintextBlob);
      const fp = computeCredentialFingerprint(plaintext);
      const row = pool.rows.find((r) => r.id === id);
      if (row) row.fingerprint = fp;
    },
  };
  return pool;
}

const validCred = (refreshSuffix: string) =>
  JSON.stringify({
    claudeAiOauth: {
      refreshToken: `rt-test-${refreshSuffix}`,
      accessToken: `at-test-${refreshSuffix}`,
      expiresAt: 9999999999999, // far future
    },
  });

describe("active-credential-watcher import-on-rotation (nx-44mby)", () => {
  let dir: string;
  let credPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nx-44mby-"));
    credPath = join(dir, ".credentials.json");
    activeTesting.resetSnapshot();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("fingerprint matches existing pool row -> pool.add() still called (update-in-place mirror)", async () => {
    const plaintext = validCred("0001");
    const fp = computeCredentialFingerprint(plaintext);
    await writeFile(credPath, plaintext);

    const pool = createFakePool([{ id: "row-existing", fingerprint: fp }]);
    await activeTesting.runRefresh(pool, credPath);

    // A fingerprint match no longer skips add() — the dedupe gate was the
    // bug (stale access tokens never refreshed once a row was imported).
    // pool.add() is idempotent: this call updates the existing row in place.
    const addCalls = pool.calls.filter((c) => c.method === "add");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.arg!.value_plaintext).toBe(plaintext);
    expect(activeTesting.getSnapshot().fingerprint).toBe(fp);
  });

  test("pool.list() throws -> pool.add() not attempted, snapshot still gets the live fingerprint (down-detection)", async () => {
    const plaintext = validCred("DOWN");
    const fp = computeCredentialFingerprint(plaintext);
    await writeFile(credPath, plaintext);

    const pool = createFakePool([]);
    pool.list = async () => {
      pool.calls.push({ method: "list" });
      throw new Error("db unreachable");
    };

    await activeTesting.runRefresh(pool, credPath);

    expect(pool.calls.filter((c) => c.method === "add")).toHaveLength(0);
    expect(activeTesting.getSnapshot().fingerprint).toBe(fp);
  });

  test("rotation with no prior observation this process (cold pool lookup): fingerprint missing from pool -> pool.add() called with live plaintext", async () => {
    const oldPlaintext = validCred("OLD");
    const oldFp = computeCredentialFingerprint(oldPlaintext);
    const newPlaintext = validCred("NEW");
    const newFp = computeCredentialFingerprint(newPlaintext);
    expect(oldFp).not.toBe(newFp); // sanity: different content -> different fp

    // Pool has the OLD row, but the watcher has NEVER observed it in this
    // process (snapshot.fingerprint starts null via resetSnapshot() in
    // beforeEach) — so there is no "previous fingerprint" to diff against,
    // and this looks identical to a cold start from the watcher's point of
    // view. add() is the correct fallback here.
    await writeFile(credPath, newPlaintext);
    const pool = createFakePool([{ id: "row-old", fingerprint: oldFp }]);

    await activeTesting.runRefresh(pool, credPath);

    const addCalls = pool.calls.filter((c) => c.method === "add");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.arg!.value_plaintext).toBe(newPlaintext);
    expect(addCalls[0]!.arg!.type).toBe("oauth");
    expect(addCalls[0]!.arg!.name).toMatch(/^acct-[0-9a-f]{8}$/);
    expect(pool.calls.filter((c) => c.method === "updateSecret")).toHaveLength(0);

    expect(activeTesting.getSnapshot().fingerprint).toBe(newFp);
  });

  test("rotation: previously observed fingerprint has a pool row -> updateSecret() updates it in place (nx-lp8v/nx-m5q6, no new row)", async () => {
    const oldPlaintext = validCred("ROT-OLD");
    const oldFp = computeCredentialFingerprint(oldPlaintext);
    const newPlaintext = validCred("ROT-NEW");
    const newFp = computeCredentialFingerprint(newPlaintext);
    expect(oldFp).not.toBe(newFp);

    // First observation: pool already has the row (as if a prior tick
    // imported it), and the live file matches it.
    await writeFile(credPath, oldPlaintext);
    const pool = createFakePool([{ id: "row-live", fingerprint: oldFp }]);
    await activeTesting.runRefresh(pool, credPath);
    expect(activeTesting.getSnapshot().fingerprint).toBe(oldFp);
    pool.calls.length = 0; // reset call log before the rotation

    // Rotation: Claude Code rewrites the live file with a new refresh token.
    await writeFile(credPath, newPlaintext);
    await activeTesting.runRefresh(pool, credPath);

    // No new row minted — the fix's entire point.
    expect(pool.calls.filter((c) => c.method === "add")).toHaveLength(0);
    const updateCalls = pool.calls.filter((c) => c.method === "updateSecret");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.updateSecretArg!.id).toBe("row-live");
    expect(
      computeCredentialFingerprint(
        JSON.stringify(updateCalls[0]!.updateSecretArg!.newPlaintextBlob),
      ),
    ).toBe(newFp);

    // Still exactly one row in the pool, now carrying the new fingerprint.
    expect(pool.rows).toHaveLength(1);
    expect(pool.rows[0]!.fingerprint).toBe(newFp);
    expect(activeTesting.getSnapshot().fingerprint).toBe(newFp);
  });

  test("rotation: previous fingerprint's row was deleted out from under the watcher -> falls back to pool.add()", async () => {
    const oldPlaintext = validCred("GONE-OLD");
    const oldFp = computeCredentialFingerprint(oldPlaintext);
    const newPlaintext = validCred("GONE-NEW");
    const newFp = computeCredentialFingerprint(newPlaintext);
    expect(oldFp).not.toBe(newFp);

    await writeFile(credPath, oldPlaintext);
    const pool = createFakePool([{ id: "row-live", fingerprint: oldFp }]);
    await activeTesting.runRefresh(pool, credPath);
    expect(activeTesting.getSnapshot().fingerprint).toBe(oldFp);

    // Row deleted externally (e.g. DELETE /credentials/:id) between polls.
    pool.rows.length = 0;
    pool.calls.length = 0;

    await writeFile(credPath, newPlaintext);
    await activeTesting.runRefresh(pool, credPath);

    expect(pool.calls.filter((c) => c.method === "updateSecret")).toHaveLength(0);
    const addCalls = pool.calls.filter((c) => c.method === "add");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.arg!.value_plaintext).toBe(newPlaintext);
    expect(activeTesting.getSnapshot().fingerprint).toBe(newFp);
  });

  test("empty pool + valid live file -> pool.add() called (cold-start case)", async () => {
    const plaintext = validCred("FRESH");
    const fp = computeCredentialFingerprint(plaintext);
    await writeFile(credPath, plaintext);
    const pool = createFakePool([]);

    await activeTesting.runRefresh(pool, credPath);

    expect(pool.calls.filter((c) => c.method === "add")).toHaveLength(1);
    expect(activeTesting.getSnapshot().fingerprint).toBe(fp);
  });

  test("missing credential file -> snapshot.fingerprint null, no pool.add()", async () => {
    const pool = createFakePool([]);
    await activeTesting.runRefresh(pool, join(dir, "does-not-exist.json"));

    expect(pool.calls.filter((c) => c.method === "add")).toHaveLength(0);
    expect(activeTesting.getSnapshot().fingerprint).toBeNull();
  });

  test("invalid JSON in credential file -> no pool.add(), snapshot null", async () => {
    await writeFile(credPath, "{ not valid json");
    const pool = createFakePool([]);

    await activeTesting.runRefresh(pool, credPath);

    expect(pool.calls.filter((c) => c.method === "add")).toHaveLength(0);
    expect(activeTesting.getSnapshot().fingerprint).toBeNull();
  });

  test("pool.add() throws -> swallow, snapshot stays null (graceful degrade)", async () => {
    const plaintext = validCred("ERR");
    await writeFile(credPath, plaintext);
    const pool = createFakePool([]);
    // Override add to throw — simulates DB error during transactional insert.
    pool.add = async () => {
      pool.calls.push({ method: "add" });
      throw new Error("simulated DB failure");
    };

    // refresh() must NOT propagate the error — it's best-effort.
    await activeTesting.runRefresh(pool, credPath);

    expect(pool.calls.filter((c) => c.method === "add")).toHaveLength(1);
    expect(activeTesting.getSnapshot().fingerprint).toBeNull();
  });
});

describe("active-credential-watcher directory-watch survives atomic replace (nx-6uzqi)", () => {
  let dir: string;
  let credPath: string;
  let ac: AbortController | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nx-6uzqi-"));
    credPath = join(dir, ".credentials.json");
    activeTesting.resetSnapshot();
  });

  afterEach(async () => {
    ac?.abort();
    ac = null;
    await rm(dir, { recursive: true, force: true });
  });

  test(
    "account switch via atomic rename-over updates activeFingerprint (regression: single-file fs.watch used to die silently after a rename-over, freezing the snapshot on the pre-switch account)",
    async () => {
      const oldPlaintext = validCred("PRESWITCH");
      const oldFp = computeCredentialFingerprint(oldPlaintext);
      await writeFile(credPath, oldPlaintext);

      const pool = createFakePool([]);
      // Short poll interval so the test doesn't need a real 60s wait. This
      // also means the test proves the fix via the POLL FALLBACK path, not
      // fs.watch: empirically, Bun's fs.watch (file- or directory-level)
      // fires zero events for a rename-over-an-existing-file, so directory
      // watching alone would NOT have caught this regression -- only the
      // poll fallback does, which is exactly what makes this a real
      // regression test rather than a re-test of the (still correct, but
      // insufficient alone) directory-watch change.
      ac = startActiveCredentialWatcher(
        pool as unknown as Parameters<typeof startActiveCredentialWatcher>[0],
        credPath,
        150,
      );

      // Wait for the initial best-effort read + watcher startup to observe
      // the pre-switch credential.
      const deadline1 = Date.now() + 2000;
      while (
        activeTesting.getSnapshot().fingerprint !== oldFp &&
        Date.now() < deadline1
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(activeTesting.getSnapshot().fingerprint).toBe(oldFp);

      // Simulate the account switch: an ATOMIC replace via temp-file +
      // rename INTO THE SAME DIRECTORY -- the class of write that kills a
      // single-file fs.watch by invalidating the inode it's bound to (the
      // nx-6uzqi root cause). A plain in-place writeFile would not exercise
      // the regression: the old file-level watch handled in-place mutation
      // fine and only broke on inode replacement.
      const newPlaintext = validCred("POSTSWITCH");
      const newFp = computeCredentialFingerprint(newPlaintext);
      expect(newFp).not.toBe(oldFp);
      const tmpFile = join(dir, ".credentials.json.tmp");
      await writeFile(tmpFile, newPlaintext);
      await rename(tmpFile, credPath);

      // Give the directory watch + 200ms debounce time to fire and the
      // fake pool.add() to resolve.
      const deadline2 = Date.now() + 3000;
      while (
        activeTesting.getSnapshot().fingerprint !== newFp &&
        Date.now() < deadline2
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(activeTesting.getSnapshot().fingerprint).toBe(newFp);
      // The account switch is a rotation of a row already tracked by this
      // watcher (inserted by the initial cold-start add() above), so it goes
      // through updateSecret() in place (nx-lp8v/nx-m5q6) rather than
      // minting a second row via add().
      expect(
        pool.calls.filter(
          (c) =>
            c.method === "updateSecret" &&
            computeCredentialFingerprint(
              JSON.stringify(c.updateSecretArg!.newPlaintextBlob),
            ) === newFp,
        ),
      ).toHaveLength(1);
      expect(
        pool.calls.filter(
          (c) => c.method === "add" && c.arg?.value_plaintext === newPlaintext,
        ),
      ).toHaveLength(0);
      expect(pool.rows).toHaveLength(1);
    },
    10000,
  );
});
