/**
 * Hook schema-drift detector.
 *
 * Spec: openspec/changes/add-schema-drift-detector
 *
 * For each incoming hook payload, compute a SHA-256 fingerprint of the
 * sorted top-level key set. Persist to `hook_schema_fingerprints` keyed by
 * `(event_type, fingerprint)`. When a *new* fingerprint is observed for an
 * event_type, emit `HookSchemaDrift` to the lifecycle bus — rate-limited to
 * at most one emit per `event_type` per hour.
 *
 * Failure mode: errors during DB lookup/insert MUST NOT propagate. The
 * detector is fire-and-forget — a transient DB hiccup must not break the
 * upstream hook ingress.
 */

import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Db } from "@nexus/db";
import { hookSchemaFingerprints } from "@nexus/db";
import { createLogger } from "@nexus/core/node";

import { lifecycleBus } from "./lifecycle-bus";
import { registerSnapshotSource } from "./state-snapshot";

const log = createLogger("agent:schema-drift");

/**
 * Rate-limit window for `HookSchemaDrift` emits: 1 fire per event_type per hour.
 */
export const DRIFT_RATE_LIMIT_MS = 60 * 60 * 1000;

/**
 * In-memory rate-limit map. The key is `event_type`; the value is the
 * epoch-ms timestamp of the last emit. Stored in module scope so the
 * limiter survives across requests but resets on agent restart (acceptable
 * — the worst case is one extra fire after a crash).
 */
const lastEmitByEventType = new Map<string, number>();

/**
 * Compute a SHA-256 fingerprint of the payload's sorted top-level key set.
 *
 * Two payloads with the same top-level shape (same keys, regardless of
 * value or nested structure) produce the same fingerprint. Non-object
 * payloads (null, primitives, arrays) collapse to a sentinel fingerprint.
 */
export function fingerprintPayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return createHash("sha256").update("__non_object__").digest("hex");
  }
  const keys = Object.keys(payload).sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

/**
 * Inspect a hook payload for schema drift.
 *
 * Behaviour:
 *   1. Compute the fingerprint.
 *   2. Look up `(event_type, fingerprint)` in `hook_schema_fingerprints`.
 *   3. If absent: INSERT the row and emit `HookSchemaDrift` (subject to
 *      the per-event_type rate limit).
 *   4. If present: UPDATE `last_seen` to NOW().
 *
 * Errors are logged and swallowed.
 */
export async function inspectAndEmitDrift(
  db: Db,
  eventType: string,
  payload: unknown,
): Promise<void> {
  const fingerprint = fingerprintPayload(payload);

  try {
    const existing = await db
      .select()
      .from(hookSchemaFingerprints)
      .where(
        and(
          eq(hookSchemaFingerprints.eventType, eventType),
          eq(hookSchemaFingerprints.fingerprint, fingerprint),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      // New pair — insert and emit (subject to rate limit).
      await db
        .insert(hookSchemaFingerprints)
        .values({
          eventType,
          fingerprint,
          firstSeen: new Date(),
          lastSeen: new Date(),
        })
        .onConflictDoNothing();

      const now = Date.now();
      const lastEmit = lastEmitByEventType.get(eventType) ?? 0;
      if (now - lastEmit >= DRIFT_RATE_LIMIT_MS) {
        lastEmitByEventType.set(eventType, now);
        lifecycleBus.emit("HookSchemaDrift", {
          eventType,
          fingerprint,
          firstSeen: new Date().toISOString(),
        });
        log.info(
          { eventType, fingerprint },
          "schema-drift: new (event_type, fingerprint) pair emitted",
        );
      } else {
        log.debug(
          { eventType, fingerprint, lastEmit },
          "schema-drift: new pair observed but emit rate-limited",
        );
      }
    } else {
      // Existing pair — bump last_seen.
      await db
        .update(hookSchemaFingerprints)
        .set({ lastSeen: new Date() })
        .where(
          and(
            eq(hookSchemaFingerprints.eventType, eventType),
            eq(hookSchemaFingerprints.fingerprint, fingerprint),
          ),
        );
    }
  } catch (err) {
    log.warn(
      { err, eventType },
      "schema-drift: detector failed (non-fatal, hook ingress continues)",
    );
  }
}

/** Test-only: clear the in-memory rate-limit cache. */
export function _resetSchemaDriftRateLimitForTest(): void {
  lastEmitByEventType.clear();
}

// Persist the per-event_type drift-emit rate limit across restarts (nx-veo5g.4,
// Layer D). Without this, a restart inside the 1-hour DRIFT_RATE_LIMIT_MS window
// re-arms an empty map and can re-emit a `HookSchemaDrift` notification already
// sent this hour. Entries whose window has already elapsed carry no suppression
// value and are dropped on serialize/restore.
registerSnapshotSource("schema-drift-emit", {
  serialize: () => {
    const cutoff = Date.now() - DRIFT_RATE_LIMIT_MS;
    return [...lastEmitByEventType.entries()].filter(([, ts]) => ts >= cutoff);
  },
  deserialize: (data) => {
    const cutoff = Date.now() - DRIFT_RATE_LIMIT_MS;
    lastEmitByEventType.clear();
    for (const [eventType, ts] of data as [string, number][]) {
      if (typeof eventType === "string" && typeof ts === "number" && ts >= cutoff) {
        lastEmitByEventType.set(eventType, ts);
      }
    }
  },
});
