/**
 * Characterization tests for the credential AES-256-GCM encryption module.
 *
 * `encryption.ts` is the crypto boundary protecting every stored credential
 * at rest and previously had ZERO tests. These tests lock in the CURRENT,
 * correct behavior so downstream work (plan 008, add-elevenlabs-credential)
 * can build on a verified foundation. They characterize existing behavior —
 * if one fails, the source drifted (a deliberate change to review), not a
 * test bug to paper over.
 *
 * What this suite locks in:
 *   1. encrypt/decrypt round-trip for short / empty / unicode / long inputs.
 *   2. Wrong-key decryption throws (never silently returns garbage).
 *   3. Tampering with ciphertext OR the GCM auth tag throws.
 *   4. loadEncryptionKey: hex and base64 decode to the same 32-byte key;
 *      invalid-length and absent vars are rejected.
 *   5. loadPrerotateThreshold: default 0.85, valid override, out-of-range
 *      and non-numeric rejection.
 *
 * Security: all keys are throwaway `randomBytes(32)` generated in-test. No
 * real key value is ever hardcoded, read, or printed.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  loadEncryptionKey,
  loadPrerotateThreshold,
} from "./encryption";

const NONCE_BYTES = 12;

describe("encryption round-trip", () => {
  const key = randomBytes(32);

  const cases: Array<[string, string]> = [
    ["short ASCII", "hunter2"],
    ["empty string", ""],
    ["unicode", "héllo-世界-🔐"],
    ["long", "a".repeat(10_000)],
  ];

  for (const [label, plaintext] of cases) {
    test(`round-trips ${label}`, () => {
      expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
    });
  }
});

describe("encryption wrong-key rejection", () => {
  test("decrypt with a different valid key throws", () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const ciphertext = encrypt("secret", keyA);
    expect(() => decrypt(ciphertext, keyB)).toThrow();
  });
});

describe("encryption tamper rejection (GCM auth)", () => {
  test("flipping a ciphertext byte throws", () => {
    const key = randomBytes(32);
    const buf = Buffer.from(encrypt("secret", key), "base64");
    // Flip a byte in the ciphertext region (index 12 .. len-16).
    buf[NONCE_BYTES + 1] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, key)).toThrow();
  });

  test("flipping an auth-tag byte throws", () => {
    const key = randomBytes(32);
    const buf = Buffer.from(encrypt("secret", key), "base64");
    // Flip a byte inside the trailing 16-byte auth tag.
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, key)).toThrow();
  });
});

describe("loadEncryptionKey", () => {
  const original = process.env.NEXUS_ENCRYPTION_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXUS_ENCRYPTION_KEY;
    else process.env.NEXUS_ENCRYPTION_KEY = original;
  });

  test("hex and base64 encodings decode to the same 32-byte key", () => {
    const raw = randomBytes(32);

    process.env.NEXUS_ENCRYPTION_KEY = raw.toString("hex"); // 64 chars
    const fromHex = loadEncryptionKey();
    expect(fromHex.length).toBe(32);
    expect(fromHex.equals(raw)).toBe(true);

    process.env.NEXUS_ENCRYPTION_KEY = raw.toString("base64"); // 44 chars
    const fromBase64 = loadEncryptionKey();
    expect(fromBase64.length).toBe(32);
    expect(fromBase64.equals(fromHex)).toBe(true);
  });

  test("invalid-length key is rejected", () => {
    process.env.NEXUS_ENCRYPTION_KEY = "deadbeef";
    expect(() => loadEncryptionKey()).toThrow();
  });

  test("absent var is rejected", () => {
    delete process.env.NEXUS_ENCRYPTION_KEY;
    expect(() => loadEncryptionKey()).toThrow();
  });
});

describe("loadPrerotateThreshold", () => {
  const original = process.env.NEXUS_PREROTATE_THRESHOLD;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXUS_PREROTATE_THRESHOLD;
    else process.env.NEXUS_PREROTATE_THRESHOLD = original;
  });

  test("defaults to 0.85 when unset", () => {
    delete process.env.NEXUS_PREROTATE_THRESHOLD;
    expect(loadPrerotateThreshold()).toBe(0.85);
  });

  test("valid override is returned", () => {
    process.env.NEXUS_PREROTATE_THRESHOLD = "0.5";
    expect(loadPrerotateThreshold()).toBe(0.5);
  });

  test("out-of-range value is rejected", () => {
    process.env.NEXUS_PREROTATE_THRESHOLD = "1.5";
    expect(() => loadPrerotateThreshold()).toThrow();
  });

  test("non-numeric value is rejected", () => {
    process.env.NEXUS_PREROTATE_THRESHOLD = "abc";
    expect(() => loadPrerotateThreshold()).toThrow();
  });
});
