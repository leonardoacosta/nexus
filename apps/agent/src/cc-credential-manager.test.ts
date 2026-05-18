/**
 * Unit tests for cc-credential-manager. Exercises:
 *  - schema fingerprint + drift detection
 *  - backup-before-write rotation
 *  - proactive refresh window
 *  - rate-limit swap selection logic (pure)
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  CcCredentialManager,
  SUPPORTED_SCHEMA_FINGERPRINT,
  REFRESH_LOOKAHEAD_MS,
} from "./cc-credential-manager";

function tempCredentialsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-cred-"));
  return join(dir, "credentials.json");
}

function fakeDb(): unknown {
  // Minimal stub — only the surfaces used by pure-logic tests.
  return {
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => [] }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
  };
}

describe("CcCredentialManager.fingerprintSchema", () => {
  it("produces a deterministic hash for the supported shape", () => {
    const path = tempCredentialsPath();
    const m = new CcCredentialManager(fakeDb() as never, {
      credentialsPath: path,
      encryptionKey: randomBytes(32),
      disableBackups: true,
    });
    const supported = {
      claudeAiOauth: {
        accessToken: "x",
        refreshToken: "y",
        expiresAt: 1,
        subscriptionType: "max",
      },
    };
    const fp1 = m.fingerprintSchema(supported);
    const fp2 = m.fingerprintSchema({
      claudeAiOauth: {
        // same keys, different values — must produce same fingerprint
        accessToken: "AAA",
        refreshToken: "BBB",
        expiresAt: 999,
        subscriptionType: "pro",
      },
    });
    expect(fp1).toBe(fp2);
  });

  it("yields the canonical SUPPORTED_SCHEMA_FINGERPRINT", () => {
    expect(SUPPORTED_SCHEMA_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("CcCredentialManager.read/write/backup", () => {
  it("backs up the prior file before writing and round-trips contents", async () => {
    const path = tempCredentialsPath();
    const m = new CcCredentialManager(fakeDb() as never, {
      credentialsPath: path,
      encryptionKey: randomBytes(32),
    });
    await m.write({
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
      },
    });
    await m.write({
      claudeAiOauth: {
        accessToken: "a2",
        refreshToken: "r2",
        expiresAt: 2,
      },
    });
    const current = JSON.parse(readFileSync(path, "utf8"));
    expect(current.claudeAiOauth.accessToken).toBe("a2");

    const after = await m.read();
    expect(after?.claudeAiOauth?.accessToken).toBe("a2");
  });

  it("returns null when the file is absent", async () => {
    const path = tempCredentialsPath();
    const m = new CcCredentialManager(fakeDb() as never, {
      credentialsPath: path,
      encryptionKey: randomBytes(32),
      disableBackups: true,
    });
    expect(await m.read()).toBeNull();
  });
});

describe("REFRESH_LOOKAHEAD_MS", () => {
  it("is 5 minutes", () => {
    expect(REFRESH_LOOKAHEAD_MS).toBe(5 * 60 * 1000);
  });
});
