/**
 * Unit tests for the credential-watcher's initial-scan phase.
 *
 * Spec: bd:nx-wo9f9
 *
 * The watcher's fs.watch event loop only fires for files modified AFTER
 * the watcher starts. In production, all ~/.config/nexus/credentials/
 * files exist at agent start time, so without an initial scan the DB
 * never gets pre-seeded — /credentials falls back to the legacy
 * filesystem-only shape and the new usage / dedupe / identity-refresh UI
 * elements stay empty.
 *
 * These tests lock in the initial-scan contract:
 *   1. On startup, every existing `acct-*.json` is processed via the
 *      same path that handleFileEvent uses for live events.
 *   2. Non-credential files (README, .DS_Store, foo.txt) are ignored.
 *   3. A missing CRED_DIR is a no-op (legitimate on fresh agent installs).
 *   4. Duplicate-fingerprint adds fall through to refreshMetadata.
 *
 * Mocking strategy: the watcher exports `runInitialScan(pool, credDir)`
 * as a direct entry point so tests can pass an injectable credDir +
 * fake-pool without spinning up real DB or filesystem watchers.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitialScan } from "./credential-watcher";

interface FakePoolCall {
  method: "add" | "refreshMetadata";
  arg?: { name: string; type: string; value_plaintext: string };
}

interface FakePool {
  add(input: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  }): Promise<void>;
  refreshMetadata(): Promise<void>;
  calls: FakePoolCall[];
  /** When set, `add` throws an Error with this message on the matching call. */
  throwOnAdd?: string;
}

function createFakePool(): FakePool {
  const pool: FakePool = {
    calls: [],
    async add(input) {
      pool.calls.push({
        method: "add",
        arg: {
          name: input.name,
          type: input.type,
          value_plaintext: input.value_plaintext,
        },
      });
      if (pool.throwOnAdd) {
        const msg = pool.throwOnAdd;
        pool.throwOnAdd = undefined;
        throw new Error(msg);
      }
    },
    async refreshMetadata() {
      pool.calls.push({ method: "refreshMetadata" });
    },
  };
  return pool;
}

// Real Claude Code credential shape — nested under `claudeAiOauth`.
// computeCredentialFingerprint() rejects credentials missing this wrapper
// (CredentialParseError: "credential is missing the claudeAiOauth object").
const validCredential = JSON.stringify({
  claudeAiOauth: {
    refreshToken: "rt-deadbeef-cafe-0001",
    accessToken: "at-deadbeef-cafe-0001",
    expiresAt: "2030-01-01T00:00:00.000Z",
  },
});

const otherValidCredential = JSON.stringify({
  claudeAiOauth: {
    refreshToken: "rt-deadbeef-cafe-0002",
    accessToken: "at-deadbeef-cafe-0002",
    expiresAt: "2030-01-01T00:00:00.000Z",
  },
});

describe("credential-watcher runInitialScan", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nx-wo9f9-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("processes every existing acct-*.json via pool.add", async () => {
    await writeFile(join(dir, "acct-001.json"), validCredential);
    await writeFile(join(dir, "acct-002.json"), otherValidCredential);

    const pool = createFakePool();
    const result = await runInitialScan(pool, dir);

    expect(result.scanned).toBe(2);
    expect(result.added).toBe(2);

    const addCalls = pool.calls.filter((c) => c.method === "add");
    expect(addCalls).toHaveLength(2);
    const names = addCalls.map((c) => c.arg!.name).sort();
    expect(names).toEqual(["acct-001", "acct-002"]);
  });

  test("ignores non-credential files (README, .DS_Store, foo.txt)", async () => {
    await writeFile(join(dir, "README.md"), "ignore me");
    await writeFile(join(dir, ".DS_Store"), "binary junk");
    await writeFile(join(dir, "foo.txt"), "also ignored");
    await writeFile(join(dir, "acct-001.json"), validCredential);

    const pool = createFakePool();
    const result = await runInitialScan(pool, dir);

    expect(result.scanned).toBe(1);
    expect(pool.calls.filter((c) => c.method === "add")).toHaveLength(1);
  });

  test("missing credential directory is a no-op (fresh-install case)", async () => {
    const pool = createFakePool();
    const result = await runInitialScan(pool, join(dir, "does-not-exist"));

    expect(result.scanned).toBe(0);
    expect(result.added).toBe(0);
    expect(pool.calls).toHaveLength(0);
  });

  test("duplicate-fingerprint add falls through to refreshMetadata", async () => {
    await writeFile(join(dir, "acct-001.json"), validCredential);

    const pool = createFakePool();
    pool.throwOnAdd = "duplicate key value violates unique constraint";

    const result = await runInitialScan(pool, dir);

    expect(result.scanned).toBe(1);
    expect(result.added).toBe(0);
    expect(result.refreshed).toBe(1);
    expect(pool.calls.map((c) => c.method)).toEqual(["add", "refreshMetadata"]);
  });

  test("skips invalid credential files without throwing", async () => {
    await writeFile(join(dir, "acct-bad.json"), "{ not valid json");
    await writeFile(join(dir, "acct-empty.json"), JSON.stringify({}));
    await writeFile(join(dir, "acct-good.json"), validCredential);

    const pool = createFakePool();
    const result = await runInitialScan(pool, dir);

    // Bad JSON + empty (no refreshToken) → skipped. Good → added.
    expect(result.scanned).toBe(3);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(2);
  });
});
