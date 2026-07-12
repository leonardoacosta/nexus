/**
 * active-credential-watcher unit tests.
 *
 * Spec: bd:nx-44mby
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
 * was written once on import and never updated again. The fix below calls
 * `pool.add()` unconditionally on every observation; it is idempotent
 * (update-in-place on a fingerprint+name match), so this keeps the pool's
 * access token current with whatever Claude Code has live, whether or not
 * the refresh token itself rotated.
 *
 * Tests below validate both the import-on-rotation contract and the
 * always-mirror contract by injecting a fake pool and overriding the
 * credentials file path via the test seam
 * `__testing.runRefresh(pool, credentialPath)`.
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
  method: "add" | "list";
  arg?: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
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
      // Mirror the production add(): on success, the row becomes visible
      // to subsequent list() calls. Test-only — real pool also writes to DB.
      const fp = computeCredentialFingerprint(input.value_plaintext);
      pool.rows.push({ id: input.id, fingerprint: fp });
      // Return value is ignored by the active watcher's rotation path; return
      // the "inserted" discriminant to satisfy CredentialPool.add's new type.
      return "inserted";
    },
    async list() {
      pool.calls.push({ method: "list" });
      return pool.rows.map((r) => ({ ...r }));
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

  test("rotation: fingerprint missing from pool -> pool.add() called with live plaintext", async () => {
    const oldPlaintext = validCred("OLD");
    const oldFp = computeCredentialFingerprint(oldPlaintext);
    const newPlaintext = validCred("NEW");
    const newFp = computeCredentialFingerprint(newPlaintext);
    expect(oldFp).not.toBe(newFp); // sanity: different content -> different fp

    // Pool only has the OLD row; live file has the NEW (rotated) credential.
    await writeFile(credPath, newPlaintext);
    const pool = createFakePool([{ id: "row-old", fingerprint: oldFp }]);

    await activeTesting.runRefresh(pool, credPath);

    const addCalls = pool.calls.filter((c) => c.method === "add");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.arg!.value_plaintext).toBe(newPlaintext);
    expect(addCalls[0]!.arg!.type).toBe("oauth");
    // The synthetic name should be derived from the new fingerprint so
    // the row is recognisable in /credentials listings.
    expect(addCalls[0]!.arg!.name).toMatch(/^acct-[0-9a-f]{8}$/);

    // After import the snapshot should reflect the NEW fingerprint (now
    // a match in the post-add pool state).
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
      expect(
        pool.calls.filter(
          (c) => c.method === "add" && c.arg?.value_plaintext === newPlaintext,
        ),
      ).toHaveLength(1);
    },
    10000,
  );
});
