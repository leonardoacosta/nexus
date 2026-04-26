/**
 * ElevenLabs credential encryption round-trip (unit — no PG).
 *
 * Validates that the AES-256-GCM helpers used by the existing Anthropic
 * credentials pipeline also work for an ElevenLabs API key. The
 * `elevenlabs_credentials.value_encrypted` column has the same shape
 * (base64 of nonce || ciphertext || authTag) so a direct round-trip is
 * sufficient to exercise the encryption layer the schema relies on.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 */

import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";

import { decrypt, encrypt } from "./encryption";

describe("elevenlabs credential encryption (unit)", () => {
  it("round-trips an ElevenLabs API key through encrypt/decrypt", () => {
    const key = randomBytes(32);
    const plaintext = "xi-test-12345-abc";

    const ciphertext = encrypt(plaintext, key);

    // Stored shape is base64; must not contain the plaintext.
    expect(ciphertext).not.toContain(plaintext);
    expect(ciphertext).not.toContain("xi-test");
    expect(ciphertext.length).toBeGreaterThan(0);

    const recovered = decrypt(ciphertext, key);
    expect(recovered).toBe(plaintext);
  });

  it("produces a fresh nonce per encrypt call (same key, same plaintext → different ciphertext)", () => {
    const key = randomBytes(32);
    const plaintext = "xi-test-12345-abc";

    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);

    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe(plaintext);
    expect(decrypt(b, key)).toBe(plaintext);
  });

  it("rejects ciphertext decrypted with the wrong key", () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const plaintext = "xi-test-12345-abc";

    const ciphertext = encrypt(plaintext, keyA);

    expect(() => decrypt(ciphertext, keyB)).toThrow();
  });
});
