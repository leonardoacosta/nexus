/**
 * Opaque cursor helpers for paginated list endpoints.
 *
 * A cursor encodes a single "last-seen" marker value (e.g. last project name
 * or path) as base64-encoded UTF-8. Callers MUST treat cursors as opaque —
 * no guarantees are made about the wire format. Invalid cursors produce a
 * `null` decode result; handlers should translate that into a 400 response.
 *
 * Format note: We deliberately avoid JSON. The encoded payload is just the
 * raw marker string base64-encoded. This keeps cursors short and hides any
 * internal key choice (name vs. path vs. uuid) from callers without requiring
 * a JSON parser round-trip.
 */

/**
 * Decode an opaque cursor string into its underlying marker value.
 * Returns `null` when the input is not valid base64 or decodes to empty.
 */
export function parseCursor(raw: string): string | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    // Round-trip check: if the input wasn't valid base64, Node silently
    // returns garbage. Re-encoding and comparing catches that.
    const reencoded = Buffer.from(decoded, "utf8").toString("base64");
    // Strip base64 padding for comparison (some clients omit it).
    const stripPadding = (s: string): string => s.replace(/=+$/, "");
    if (stripPadding(reencoded) !== stripPadding(raw)) return null;
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Encode a marker string into an opaque cursor. */
export function encodeCursor(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Parse and clamp a `limit` query param.
 *
 * - Returns the default when missing or non-numeric (silent fallback).
 * - Clamps to [1, max] silently (per spec: out-of-range values are clamped,
 *   not rejected).
 */
export function parseLimit(
  raw: string | null,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (raw === null || raw === "") return defaultLimit;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultLimit;
  const n = Math.floor(parsed);
  if (n < 1) return 1;
  if (n > maxLimit) return maxLimit;
  return n;
}
