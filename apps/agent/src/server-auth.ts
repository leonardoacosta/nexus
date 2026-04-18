/**
 * REST auth and ID validation helpers extracted from server.ts.
 *
 * Encapsulates:
 * - ATTACH_SECRET (NEXUS_ATTACH_SECRET env var, fail-closed)
 * - Constant-time x-nexus-secret header validation
 * - Credential ID regex used across route pre-validation
 */

import { timingSafeEqual } from "node:crypto";
import { logger } from "@nexus/core/node";

// ── Security: attach secret ─────────────────────────────────────────────────
const _attachSecretRaw = process.env.NEXUS_ATTACH_SECRET;
if (!_attachSecretRaw) {
  logger.error("NEXUS_ATTACH_SECRET is not set — refusing to start (fail-closed)");
  process.exit(1);
}
export const ATTACH_SECRET: string = _attachSecretRaw;

// ── Credential ID validation ────────────────────────────────────────────────
export const CREDENTIAL_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate the `x-nexus-secret` header using constant-time comparison.
 *
 * Returns `null` on success (header matches ATTACH_SECRET).
 * Returns a `Response(401)` when the header is missing or does not match.
 * A missing header is normalised to an empty string before comparison so that
 * `Buffer.from(null)` is never called.
 */
export function requireSecret(request: Request): Response | null {
  const provided = request.headers.get("x-nexus-secret") ?? "";
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(ATTACH_SECRET);
  // timingSafeEqual requires same-length buffers; treat length mismatch as failure.
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
