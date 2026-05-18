/**
 * AES-256-GCM encryption helpers for credential values at rest.
 *
 * Storage format: base64(nonce[12] || ciphertext[n] || authTag[16])
 *
 * The key is loaded from NEXUS_ENCRYPTION_KEY at startup. Accepts:
 *   - 64-char hex string  (32 bytes)
 *   - 44-char base64 string (32 bytes)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm" as const;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * @param plaintext - the value to encrypt
 * @param key - 32-byte Buffer (from loadEncryptionKey)
 * @returns base64-encoded nonce || ciphertext || authTag
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([nonce, encrypted, authTag]);
  return combined.toString("base64");
}

/**
 * Decrypt a base64-encoded ciphertext produced by `encrypt`.
 *
 * @param ciphertext - base64-encoded nonce || ciphertext || authTag
 * @param key - 32-byte Buffer (from loadEncryptionKey)
 * @returns the original plaintext string
 * @throws if decryption or authentication fails
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const combined = Buffer.from(ciphertext, "base64");
  if (combined.length < NONCE_BYTES + AUTH_TAG_BYTES) {
    throw new Error("decrypt: ciphertext too short — invalid or corrupted");
  }
  const nonce = combined.subarray(0, NONCE_BYTES);
  const authTag = combined.subarray(combined.length - AUTH_TAG_BYTES);
  const encrypted = combined.subarray(NONCE_BYTES, combined.length - AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/**
 * Load and validate the encryption key from the NEXUS_ENCRYPTION_KEY environment variable.
 *
 * Accepts:
 *   - 64-char hex string  → 32 bytes
 *   - 44-char base64 string → 32 bytes
 *
 * @throws if the variable is absent, malformed, or not exactly 32 bytes
 */
export function loadEncryptionKey(): Buffer {
  const raw = process.env.NEXUS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "NEXUS_ENCRYPTION_KEY is not set. " +
        "Generate a key with: openssl rand -hex 32",
    );
  }

  let key: Buffer;

  if (raw.length === 64 && /^[0-9a-fA-F]{64}$/.test(raw)) {
    // 64-char hex → 32 bytes
    key = Buffer.from(raw, "hex");
  } else if (raw.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    // 44-char base64 → 32 bytes
    key = Buffer.from(raw, "base64");
  } else {
    throw new Error(
      "NEXUS_ENCRYPTION_KEY is malformed. " +
        "Expected a 64-char hex string or a 44-char base64 string (both encoding 32 bytes). " +
        `Got length=${raw.length}.`,
    );
  }

  if (key.length !== 32) {
    throw new Error(
      `NEXUS_ENCRYPTION_KEY decoded to ${key.length} bytes; expected exactly 32.`,
    );
  }

  return key;
}

/**
 * Load the pre-rotation threshold from NEXUS_PREROTATE_THRESHOLD.
 * Defaults to 0.85. Must be in the range (0.0, 1.0].
 *
 * @throws if the value is present but invalid
 */
export function loadPrerotateThreshold(): number {
  const raw = process.env.NEXUS_PREROTATE_THRESHOLD;
  if (!raw) return 0.85;

  const value = parseFloat(raw);
  if (isNaN(value) || value <= 0.0 || value > 1.0) {
    throw new Error(
      `NEXUS_PREROTATE_THRESHOLD must be a number in (0.0, 1.0], got: "${raw}"`,
    );
  }
  return value;
}
