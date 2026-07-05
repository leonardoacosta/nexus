/**
 * Encryption round-trip against the `elevenlabs_credentials` schema.
 *
 * The generic AES-256-GCM behavior is characterized in `encryption.test.ts`.
 * This suite locks in the schema-level contract that add-elevenlabs-credential
 * relies on: a `NewElevenlabsCredential` insert row carries the API key only
 * as ciphertext in `valueEncrypted`, and that ciphertext decrypts back to the
 * original key. Voice metadata stays plain text. If the schema column shape or
 * the crypto boundary drifts, this fails at type-check or at runtime.
 *
 * Security: throwaway `randomBytes(32)` key generated in-test; no real key or
 * plaintext key value is hardcoded, read from env, or printed.
 */

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import type { NewElevenlabsCredential } from "@nexus/db";

import { decrypt, encrypt } from "./encryption";

describe("elevenlabs_credentials encryption round-trip", () => {
  const key = randomBytes(32);

  test("valueEncrypted decrypts back to the original API key", () => {
    const apiKey = "sk_elevenlabs_test_" + randomBytes(8).toString("hex");

    const row: NewElevenlabsCredential = {
      id: "el-cred-homelab",
      agentId: "homelab",
      valueEncrypted: encrypt(apiKey, key),
      encryptionKeyId: "v1",
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      voiceName: "Rachel",
    };

    // Ciphertext must not leak the plaintext key.
    expect(row.valueEncrypted).toBeString();
    expect(row.valueEncrypted).not.toContain(apiKey);

    // And it round-trips.
    expect(decrypt(row.valueEncrypted!, key)).toBe(apiKey);

    // Voice metadata is stored plain text (not encrypted).
    expect(row.voiceId).toBe("21m00Tcm4TlvDq8ikWAM");
    expect(row.voiceName).toBe("Rachel");
  });

  test("empty / unset valueEncrypted is allowed (signal-only agents)", () => {
    const row: NewElevenlabsCredential = {
      id: "el-cred-none",
      agentId: "laptop",
    };
    expect(row.valueEncrypted ?? null).toBeNull();
  });
});
