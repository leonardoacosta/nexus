import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "@nexus/core";
import {
  insertCredential,
  getCredentialById,
  queryAllCredentials,
  queryExpiredCooldowns,
  queryStaleLeases,
} from "./store";
import type { CredentialRow } from "./store";
import { encrypt, decrypt } from "./encryption";
import type { Buffer } from "node:buffer";
import * as Sentry from "@sentry/node";

/** Default cooldown duration in milliseconds (5 minutes). */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** Default lease TTL in milliseconds (30 minutes). */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** Five-hour window in milliseconds for predictive pre-rotation utilization check. */
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

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

  /** Add a new credential to the pool (value is encrypted at rest). */
  async add(credential: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  }): Promise<void> {
    const key = this.requireKey();
    const valueEncrypted = encrypt(credential.value_plaintext, key);

    await insertCredential(this.db, {
      id: credential.id,
      name: credential.name,
      type: credential.type,
      valueEncrypted,
      encryptionKeyId: "v1",
      status: "available",
      leasedBy: null,
      leasedAt: null,
      cooldownUntil: null,
      rateLimitCount: 0,
    });
    logger.info({ id: credential.id, name: credential.name }, "credential added to pool");
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
          // Weighted round-robin: ORDER BY rate_limit_count ASC, leased_at ASC NULLS FIRST
          const rows = await tx
            .select()
            .from(credentials)
            .where(and(eq(credentials.status, "available"), eq(credentials.type, type)))
            .orderBy(
              sql`${credentials.rateLimitCount} ASC, ${credentials.leasedAt} ASC NULLS FIRST`,
            )
            .for("update")
            .limit(1);

          if (rows.length === 0) {
            return null;
          }

          const credential = rows[0]!;
          const now = new Date().toISOString();

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

        const cooldownUntil = new Date(Date.now() + this.cooldownMs).toISOString();

        // Atomically increment rate_limit_count and transition to cooldown
        await this.db
          .update(credentials)
          .set({
            status: "cooldown",
            leasedBy: null,
            leasedAt: null,
            cooldownUntil,
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

  /** List all credentials with status info (no values exposed). */
  async list(): Promise<Array<Omit<CredentialRow, "valueEncrypted">>> {
    return (await queryAllCredentials(this.db)).map(
      ({ valueEncrypted: _e, ...rest }) => rest,
    );
  }

  /** Recover credentials whose cooldown has expired. */
  async recoverExpiredCooldowns(): Promise<number> {
    const expired = await queryExpiredCooldowns(this.db);
    for (const credential of expired) {
      await this.db
        .update(credentials)
        .set({ status: "available", leasedBy: null, leasedAt: null, cooldownUntil: null })
        .where(eq(credentials.id, credential.id));
      logger.info(
        { id: credential.id, event: "credential.cooldown_exited" },
        "credential recovered from cooldown",
      );
    }
    return expired.length;
  }

  /** Clean up stale leases (leased longer than TTL). */
  async cleanupStaleLeases(): Promise<number> {
    const threshold = new Date(Date.now() - this.leaseTtlMs).toISOString();
    const stale = await queryStaleLeases(this.db, threshold);
    for (const credential of stale) {
      await this.db
        .update(credentials)
        .set({ status: "available", leasedBy: null, leasedAt: null, cooldownUntil: null })
        .where(eq(credentials.id, credential.id));
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
    const windowStart = new Date(Date.now() - FIVE_HOUR_MS).toISOString();

    // Find leased credentials that have accumulated rate limit hits in the window
    const leasedRows = await this.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.status, "leased"),
          sql`${credentials.rateLimitCount} > 0`,
          sql`${credentials.leasedAt} >= ${windowStart}`,
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
