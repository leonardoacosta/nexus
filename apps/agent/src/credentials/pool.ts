import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq, and, sql, asc, gt, gte, inArray } from "drizzle-orm";
import { logger } from "@nexus/core";
import {
  getCredentialById,
  queryAllCredentials,
  queryExpiredCooldowns,
  queryStaleLeases,
} from "./store";
import type { CredentialRow } from "./store";
import { encrypt, decrypt } from "./encryption";
import {
  computeCredentialFingerprint,
  CredentialParseError,
} from "./credentials.helpers";
import type { Buffer } from "node:buffer";
import * as Sentry from "@sentry/node";

/** Default cooldown duration in milliseconds (5 minutes). */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** Default lease TTL in milliseconds (30 minutes). */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** Five-hour window in milliseconds for predictive pre-rotation utilization check. */
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/**
 * Thrown when `CredentialPool.deleteById()` is called against a primary row
 * whose duplicate group has more than one member, but the caller did not
 * supply a `promoteId`. HTTP handlers translate this to 409 Conflict so the
 * caller can retry with `?promote=<sibling_id>`.
 */
export class CredentialDeleteError extends Error {
  readonly code = "REQUIRES_PROMOTE" as const;
  /** Sibling ids the caller can use as the promotion target. */
  readonly siblings: readonly string[];

  constructor(message: string, siblings: readonly string[]) {
    super(message);
    this.name = "CredentialDeleteError";
    this.siblings = siblings;
  }
}

/**
 * Result of a successful `CredentialPool.promote()` call. The IDs let the
 * HTTP layer emit a precise audit log entry without re-querying the row.
 */
export interface CredentialPromoteResult {
  groupId: string;
  newPrimary: string;
  /** Null when the promoted row was already primary (no-op). */
  previousPrimary: string | null;
}

/** Credential pool with lease/release/cooldown lifecycle. */
export class CredentialPool {
  private db: Db;
  private cooldownMs: number;
  private leaseTtlMs: number;
  private encryptionKey: Buffer | null;
  private prerotateThreshold: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Db,
    options?: {
      cooldownMs?: number;
      leaseTtlMs?: number;
      encryptionKey?: Buffer;
      prerotateThreshold?: number;
    },
  ) {
    this.db = db;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.leaseTtlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.encryptionKey = options?.encryptionKey ?? null;
    this.prerotateThreshold = options?.prerotateThreshold ?? 0.85;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private requireKey(): Buffer {
    if (!this.encryptionKey) {
      throw new Error(
        "CredentialPool: encryption key not configured. " +
          "Pass encryptionKey to constructor or set NEXUS_ENCRYPTION_KEY.",
      );
    }
    return this.encryptionKey;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Add a new credential to the pool (value is encrypted at rest).
   *
   * Computes the credential's fingerprint from the decrypted plaintext and
   * attaches the new row to its duplicate group. If no row in the same group
   * exists yet, the new row becomes the group's primary. Otherwise the row
   * is inserted with `is_primary = false`; the caller / a follow-up step
   * decides whether to promote it.
   *
   * Throws `CredentialParseError` (re-thrown with original `code` set) if
   * the plaintext cannot be parsed as an OAuth blob — HTTP handlers should
   * translate this to a 400.
   */
  async add(credential: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  }): Promise<void> {
    const key = this.requireKey();

    // Compute the fingerprint up front. If parsing fails, surface the typed
    // error so the HTTP layer can return 400 BAD_REQUEST instead of 500.
    let fingerprint: string;
    try {
      fingerprint = computeCredentialFingerprint(credential.value_plaintext);
    } catch (err) {
      if (err instanceof CredentialParseError) {
        throw err;
      }
      throw new CredentialParseError(
        `failed to compute credential fingerprint: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const valueEncrypted = encrypt(credential.value_plaintext, key);
    const now = new Date();

    await this.db.transaction(async (tx) => {
      // Look for an existing primary in the same duplicate group.
      const existingPrimaryRows = await tx
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.duplicateGroupId, fingerprint),
            eq(credentials.isPrimary, true),
          ),
        )
        .limit(1);

      const existingPrimary = existingPrimaryRows[0] ?? null;
      const isFirstInGroup = existingPrimary === null;

      // Determine whether the new row should outrank the current primary.
      // Newest mtime (updatedAt) wins; tiebreak alphabetical name ascending.
      // First-in-group is unconditionally primary.
      let newRowIsPrimary = isFirstInGroup;
      if (existingPrimary !== null) {
        const newMtime = now.getTime();
        const oldMtime = existingPrimary.updatedAt.getTime();
        if (newMtime > oldMtime) {
          newRowIsPrimary = true;
        } else if (newMtime === oldMtime) {
          newRowIsPrimary =
            credential.name.localeCompare(existingPrimary.name) < 0;
        }
      }

      await tx.insert(credentials).values({
        id: credential.id,
        name: credential.name,
        type: credential.type,
        valueEncrypted,
        encryptionKeyId: "v1",
        // NULL = shared across all agents (current implicit behavior).
        agentId: null,
        status: "available",
        leasedBy: null,
        leasedAt: null,
        cooldownUntil: null,
        rateLimitCount: 0,
        fingerprint,
        duplicateGroupId: fingerprint,
        isPrimary: newRowIsPrimary,
        createdAt: now,
        updatedAt: now,
      });

      // If the new row is taking over as primary, demote the existing one
      // in the same transaction so the group has exactly one primary at all
      // times.
      if (newRowIsPrimary && existingPrimary !== null) {
        await tx
          .update(credentials)
          .set({ isPrimary: false })
          .where(eq(credentials.id, existingPrimary.id));
        logger.info(
          {
            id: credential.id,
            demotedId: existingPrimary.id,
            fingerprint,
            event: "credential.primary_swap",
          },
          "credential primary swapped on add (newer mtime)",
        );
      }
    });

    logger.info(
      { id: credential.id, name: credential.name, fingerprint },
      "credential added to pool",
    );
  }

  /**
   * Lease the next available credential of the given type.
   *
   * Weighted round-robin: prefers credentials with fewer historical rate-limit
   * events (rate_limit_count ASC), then oldest-lease-first (leased_at ASC NULLS FIRST).
   *
   * The read + update is wrapped in a transaction with SELECT FOR UPDATE to
   * prevent concurrent callers from double-leasing the same credential.
   *
   * Returns the credential row with the decrypted value, or null if exhausted.
   */
  async lease(type: string, leasedBy: string): Promise<CredentialRow | null> {
    return Sentry.startSpan(
      { name: "credential.lease", attributes: { type, leasedBy } },
      async () => {
        // First, recover any expired cooldowns (outside transaction — best-effort)
        await this.recoverExpiredCooldowns();

        const result = await this.db.transaction(async (tx) => {
          // Weighted round-robin: ORDER BY rate_limit_count ASC, leased_at ASC NULLS FIRST.
          // SAFE: static SQL fragment, no user input interpolated. Drizzle's asc()
          // helper does not support NULLS FIRST; the literal column name matches
          // the schema mapping credentials.leasedAt → "leased_at" column.
          const rows = await tx
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.status, "available"),
                eq(credentials.type, type),
                // credential-identity: only primary rows are leaseable.
                // Non-primary duplicates remain visible in GET /credentials
                // but never participate in lease selection.
                eq(credentials.isPrimary, true),
              ),
            )
            .orderBy(
              asc(credentials.rateLimitCount),
              sql`leased_at asc nulls first`,
            )
            .for("update")
            .limit(1);

          if (rows.length === 0) {
            return null;
          }

          const credential = rows[0]!;
          const now = new Date();

          await tx
            .update(credentials)
            .set({ status: "leased", leasedBy, leasedAt: now, cooldownUntil: null })
            .where(eq(credentials.id, credential.id));

          // Re-fetch within the transaction to get the final state
          const updated = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.id, credential.id))
            .limit(1);

          return updated[0] ?? null;
        });

        if (result === null) {
          logger.warn({ type }, "credential pool exhausted");
          return null;
        }

        // Decrypt the stored value before returning to the caller
        const key = this.requireKey();
        const decryptedRow: CredentialRow = {
          ...result,
          valueEncrypted: result.valueEncrypted
            ? decrypt(result.valueEncrypted, key)
            : null,
        };

        logger.info(
          { id: result.id, leasedBy, event: "credential.leased" },
          "credential leased",
        );
        Sentry.addBreadcrumb({
          category: "credential",
          message: "credential leased",
          level: "info",
          data: { id: result.id, type, leasedBy },
        });
        return decryptedRow;
      },
    );
  }

  /** Release a leased credential back to available. */
  async release(id: string): Promise<boolean> {
    return Sentry.startSpan(
      { name: "credential.release", attributes: { id } },
      async () => {
        const credential = await getCredentialById(this.db, id);
        if (!credential) {
          logger.warn({ id }, "release failed — credential not found");
          return false;
        }

        if (credential.status !== "leased") {
          logger.warn({ id, status: credential.status }, "release failed — credential not in leased state");
          return false;
        }

        await this.db
          .update(credentials)
          .set({ status: "available", leasedBy: null, leasedAt: null, cooldownUntil: null })
          .where(eq(credentials.id, id));

        logger.info({ id, event: "credential.released" }, "credential released");
        Sentry.addBreadcrumb({
          category: "credential",
          message: "credential released",
          level: "info",
          data: { id },
        });
        return true;
      },
    );
  }

  /**
   * Put a credential on cooldown (e.g., after rate limit detection).
   *
   * Atomically increments rate_limit_count and sets status to cooldown.
   * Returns the cooled-down credential row and the next available credential (or null).
   */
  async reportRateLimit(
    id: string,
    leasedBy: string,
  ): Promise<{ cooledDown: CredentialRow; next: CredentialRow | null } | null> {
    return Sentry.startSpan(
      { name: "credential.cooldown", attributes: { id } },
      async () => {
        const credential = await getCredentialById(this.db, id);
        if (!credential) return null;

        const cooldownUntil = new Date(Date.now() + this.cooldownMs);

        // Atomically increment rate_limit_count and transition to cooldown
        await this.db
          .update(credentials)
          .set({
            status: "cooldown",
            leasedBy: null,
            leasedAt: null,
            cooldownUntil,
            // SAFE: Drizzle sql tag parameterizes column ref + literal
            rateLimitCount: sql`${credentials.rateLimitCount} + 1`,
          })
          .where(eq(credentials.id, id));

        logger.info(
          { id, cooldown_until: cooldownUntil, event: "credential.cooldown_entered" },
          "credential on cooldown (rate limited)",
        );
        Sentry.addBreadcrumb({
          category: "credential",
          message: "credential on cooldown",
          level: "warning",
          data: { id, cooldown_until: cooldownUntil },
        });

        const cooledDown = (await getCredentialById(this.db, id))!;

        // Try to lease the next available credential of the same type
        const next = await this.lease(credential.type, leasedBy);

        return { cooledDown, next };
      },
    );
  }

  /**
   * Return the decrypted plaintext value for a credential, or null if not found.
   * Used by the health-check endpoint to probe the credential without leasing it.
   */
  async getDecrypted(id: string): Promise<string | null> {
    const row = await getCredentialById(this.db, id);
    if (!row) return null;
    if (!row.valueEncrypted) return null;
    const key = this.requireKey();
    return decrypt(row.valueEncrypted, key);
  }

  /**
   * Promote the given credential to `is_primary = true` within its duplicate
   * group, atomically demoting whoever currently holds the primary slot.
   *
   * Idempotent: if the row is already primary, returns immediately with
   * `previousPrimary = null` so callers can skip side effects (audit log,
   * symlink swap) on no-op promotions.
   *
   * @throws Error("credential not found") when `id` is unknown.
   * @throws Error("cross-group promotion not allowed") when the existing
   *   primary belongs to a different `duplicate_group_id` than `id` — this
   *   should never happen in steady state and indicates a data drift bug.
   */
  async promote(id: string): Promise<CredentialPromoteResult> {
    return Sentry.startSpan(
      { name: "credential.promote", attributes: { id } },
      async () => {
        return this.db.transaction(async (tx) => {
          const targetRows = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.id, id))
            .limit(1);
          const target = targetRows[0];
          if (!target) {
            throw new Error("credential not found");
          }

          const groupId = target.duplicateGroupId ?? target.fingerprint;

          // Idempotent no-op if already primary.
          if (target.isPrimary) {
            return {
              groupId,
              newPrimary: target.id,
              previousPrimary: null,
            };
          }

          const currentPrimaryRows = await tx
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.duplicateGroupId, groupId),
                eq(credentials.isPrimary, true),
              ),
            )
            .limit(1);
          const currentPrimary = currentPrimaryRows[0] ?? null;

          // Defensive guard: if a primary somehow exists in a different
          // duplicate_group_id (data drift), refuse to swap and surface the
          // inconsistency to the caller.
          if (
            currentPrimary !== null &&
            (currentPrimary.duplicateGroupId ?? currentPrimary.fingerprint) !==
              groupId
          ) {
            throw new Error("cross-group promotion not allowed");
          }

          if (currentPrimary !== null) {
            await tx
              .update(credentials)
              .set({ isPrimary: false })
              .where(eq(credentials.id, currentPrimary.id));
          }

          await tx
            .update(credentials)
            .set({ isPrimary: true })
            .where(eq(credentials.id, target.id));

          logger.info(
            {
              id: target.id,
              demotedId: currentPrimary?.id ?? null,
              fingerprint: groupId,
              event: "credential.promoted",
            },
            "credential promoted to primary",
          );

          return {
            groupId,
            newPrimary: target.id,
            previousPrimary: currentPrimary?.id ?? null,
          };
        });
      },
    );
  }

  /**
   * Delete a credential by id with orphan protection.
   *
   * Behavior:
   * - Unknown id → throws `Error("credential not found")`.
   * - `is_primary = false`, OR group size 1 → row is deleted unconditionally.
   * - `is_primary = true` AND group has more than one member:
   *   - No `opts.promoteId` → throws `CredentialDeleteError` with the list
   *     of eligible sibling ids; HTTP layer translates to 409.
   *   - With `opts.promoteId` → promotes the named sibling first
   *     (re-using `promote()` semantics), then deletes the original row.
   *
   * All DB writes for the multi-member primary case run in a single
   * transaction so a crash mid-delete cannot leave the group without a
   * primary.
   */
  async deleteById(
    id: string,
    opts?: { promoteId?: string },
  ): Promise<void> {
    return Sentry.startSpan(
      { name: "credential.delete", attributes: { id } },
      async () => {
        await this.db.transaction(async (tx) => {
          const targetRows = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.id, id))
            .limit(1);
          const target = targetRows[0];
          if (!target) {
            throw new Error("credential not found");
          }

          const groupId = target.duplicateGroupId ?? target.fingerprint;

          // Fetch every member of the same duplicate group so we can decide
          // whether orphan protection applies and so the error response can
          // name the eligible promotion targets.
          const groupMembers = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.duplicateGroupId, groupId));

          const isMultiMember = groupMembers.length > 1;
          const isPrimary = target.isPrimary;

          // Primary of a multi-member group requires explicit promotion.
          if (isPrimary && isMultiMember) {
            const siblings = groupMembers
              .filter((m) => m.id !== target.id)
              .map((m) => m.id);

            if (!opts?.promoteId) {
              throw new CredentialDeleteError(
                `cannot delete primary credential ${id}: group has ${groupMembers.length} members, must specify a sibling id via promoteId`,
                siblings,
              );
            }

            if (!siblings.includes(opts.promoteId)) {
              throw new CredentialDeleteError(
                `promoteId ${opts.promoteId} is not a sibling of ${id}`,
                siblings,
              );
            }

            // Inline promotion (cannot call this.promote because it opens
            // its own transaction). Demote target, promote sibling.
            await tx
              .update(credentials)
              .set({ isPrimary: false })
              .where(eq(credentials.id, target.id));
            await tx
              .update(credentials)
              .set({ isPrimary: true })
              .where(eq(credentials.id, opts.promoteId));

            logger.info(
              {
                id: target.id,
                promotedId: opts.promoteId,
                fingerprint: groupId,
                event: "credential.promoted",
              },
              "credential promoted to primary (delete-with-promote)",
            );
          }

          // Finally, delete the original row.
          await tx.delete(credentials).where(eq(credentials.id, target.id));

          logger.info(
            {
              id: target.id,
              fingerprint: groupId,
              promotedId: opts?.promoteId ?? null,
              event: "credential.deleted",
            },
            "credential deleted from pool",
          );
        });
      },
    );
  }

  /** List all credentials with status info (no values exposed). */
  async list(): Promise<Array<Omit<CredentialRow, "valueEncrypted">>> {
    return (await queryAllCredentials(this.db)).map(
      ({ valueEncrypted: _e, ...rest }) => rest,
    );
  }

  /** Recover credentials whose cooldown has expired. */
  async recoverExpiredCooldowns(): Promise<number> {
    const expired = await queryExpiredCooldowns(this.db);
    if (expired.length === 0) return 0;

    const ids = expired.map((c) => c.id);

    await this.db
      .update(credentials)
      .set({ status: "available", leasedBy: null, leasedAt: null, cooldownUntil: null })
      .where(inArray(credentials.id, ids));

    for (const credential of expired) {
      logger.info(
        { id: credential.id, event: "credential.cooldown_exited" },
        "credential recovered from cooldown",
      );
    }
    return expired.length;
  }

  /** Clean up stale leases (leased longer than TTL). */
  async cleanupStaleLeases(): Promise<number> {
    const threshold = new Date(Date.now() - this.leaseTtlMs);
    const stale = await queryStaleLeases(this.db, threshold);
    if (stale.length === 0) return 0;

    const ids = stale.map((c) => c.id);

    await this.db
      .update(credentials)
      .set({ status: "available", leasedBy: null, leasedAt: null, cooldownUntil: null })
      .where(inArray(credentials.id, ids));

    for (const credential of stale) {
      logger.info(
        { id: credential.id, event: "credential.stale_lease_released" },
        "stale lease released",
      );
    }
    return stale.length;
  }

  /**
   * Check all currently-leased credentials for predictive pre-rotation.
   *
   * A credential is proactively rotated when its 5-hour utilization rate
   * (rate_limit_count / maximum_per_5h) reaches the configured threshold.
   *
   * Since we track cumulative hits rather than a sliding-window rate, we use
   * the leasedAt timestamp as a proxy: if the credential has accumulated hits
   * in a short window, the density approaches the threshold.
   *
   * Simplified implementation: rotate any credential whose rate_limit_count
   * incremented at all within the last 5 hours (i.e., leasedAt is within the
   * window AND rate_limit_count > 0). Full utilization tracking deferred to a
   * future change when the usage API is integrated.
   */
  async checkPrerotation(): Promise<number> {
    const windowStart = new Date(Date.now() - FIVE_HOUR_MS);

    // Find leased credentials that have accumulated rate limit hits in the window
    const leasedRows = await this.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.status, "leased"),
          gt(credentials.rateLimitCount, 0),
          gte(credentials.leasedAt, windowStart),
        ),
      );

    let rotated = 0;
    for (const cred of leasedRows) {
      // Compute a simplified utilization: assume a cap of 50 calls/5h (Anthropic default)
      const cap = 50;
      const utilization = (cred.rateLimitCount ?? 0) / cap;
      if (utilization >= this.prerotateThreshold && cred.leasedBy) {
        logger.info(
          {
            id: cred.id,
            utilization,
            threshold: this.prerotateThreshold,
            event: "credential.prerotation_triggered",
          },
          "predictive pre-rotation: rotating credential before exhaustion",
        );
        await this.reportRateLimit(cred.id, cred.leasedBy);
        rotated++;
      }
    }
    return rotated;
  }

  /** Start periodic cleanup of expired cooldowns and stale leases. */
  startCleanup(intervalMs: number = 60_000): void {
    this.cleanupTimer = setInterval(async () => {
      await this.recoverExpiredCooldowns().catch((err) =>
        logger.error({ err }, "cleanup: recoverExpiredCooldowns failed"),
      );
      await this.cleanupStaleLeases().catch((err) =>
        logger.error({ err }, "cleanup: cleanupStaleLeases failed"),
      );
      await this.checkPrerotation().catch((err) =>
        logger.error({ err }, "cleanup: checkPrerotation failed"),
      );
    }, intervalMs);
  }

  /** Stop the cleanup timer. */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
