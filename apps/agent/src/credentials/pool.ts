import type { Db } from "@nexus/db";
import { logger } from "@nexus/core";
import {
  insertCredential,
  getCredentialById,
  queryAllCredentials,
  queryCredentialsByStatus,
  updateCredentialStatus,
  queryExpiredCooldowns,
  queryStaleLeases,
} from "./store";
import type { CredentialRow } from "./store";

/** Default cooldown duration in milliseconds (5 minutes). */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** Default lease TTL in milliseconds (30 minutes). */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** Credential pool with lease/release/cooldown lifecycle. */
export class CredentialPool {
  private db: Db;
  private cooldownMs: number;
  private leaseTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Db,
    options?: { cooldownMs?: number; leaseTtlMs?: number },
  ) {
    this.db = db;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.leaseTtlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** Add a new credential to the pool. */
  async add(credential: {
    id: string;
    name: string;
    type: string;
    value_plaintext: string;
  }): Promise<void> {
    await insertCredential(this.db, {
      id: credential.id,
      name: credential.name,
      type: credential.type,
      valuePlaintext: credential.value_plaintext,
      status: "available",
      leasedBy: null,
      leasedAt: null,
      cooldownUntil: null,
    });
    logger.info({ id: credential.id, name: credential.name }, "credential added to pool");
  }

  /**
   * Lease the next available credential of the given type (round-robin).
   * Returns the credential row or null if the pool is exhausted.
   */
  async lease(type: string, leasedBy: string): Promise<CredentialRow | null> {
    // First, recover any expired cooldowns
    await this.recoverExpiredCooldowns();

    // Find first available credential of this type
    const available = (await queryCredentialsByStatus(this.db, "available")).filter(
      (c) => c.type === type,
    );

    if (available.length === 0) {
      logger.warn({ type }, "credential pool exhausted");
      return null;
    }

    const credential = available[0]!;
    const now = new Date().toISOString();

    await updateCredentialStatus(this.db, credential.id, "leased", leasedBy, now, null);

    const updated = await getCredentialById(this.db, credential.id);
    logger.info({ id: credential.id, leasedBy }, "credential leased");

    return updated;
  }

  /** Release a leased credential back to available. */
  async release(id: string): Promise<boolean> {
    const credential = await getCredentialById(this.db, id);
    if (!credential) {
      logger.warn({ id }, "release failed — credential not found");
      return false;
    }

    if (credential.status !== "leased") {
      logger.warn({ id, status: credential.status }, "release failed — credential not in leased state");
      return false;
    }

    await updateCredentialStatus(this.db, id, "available", null, null, null);
    logger.info({ id }, "credential released");
    return true;
  }

  /**
   * Put a credential on cooldown (e.g., after rate limit detection).
   * Returns the next available credential of the same type, or null.
   */
  async reportRateLimit(
    id: string,
    leasedBy: string,
  ): Promise<{ cooledDown: CredentialRow; next: CredentialRow | null } | null> {
    const credential = await getCredentialById(this.db, id);
    if (!credential) return null;

    const cooldownUntil = new Date(Date.now() + this.cooldownMs).toISOString();
    await updateCredentialStatus(this.db, id, "cooldown", null, null, cooldownUntil);

    logger.info({ id, cooldown_until: cooldownUntil }, "credential on cooldown (rate limited)");

    const cooledDown = (await getCredentialById(this.db, id))!;

    // Try to lease the next available credential of the same type
    const next = await this.lease(credential.type, leasedBy);

    return { cooledDown, next };
  }

  /** List all credentials with status info (no values exposed). */
  async list(): Promise<Array<Omit<CredentialRow, "valuePlaintext">>> {
    return (await queryAllCredentials(this.db)).map(({ valuePlaintext: _, ...rest }) => rest);
  }

  /** Recover credentials whose cooldown has expired. */
  async recoverExpiredCooldowns(): Promise<number> {
    const expired = await queryExpiredCooldowns(this.db);
    for (const credential of expired) {
      await updateCredentialStatus(this.db, credential.id, "available", null, null, null);
      logger.info({ id: credential.id }, "credential recovered from cooldown");
    }
    return expired.length;
  }

  /** Clean up stale leases (leased longer than TTL). */
  async cleanupStaleLeases(): Promise<number> {
    const threshold = new Date(Date.now() - this.leaseTtlMs).toISOString();
    const stale = await queryStaleLeases(this.db, threshold);
    for (const credential of stale) {
      await updateCredentialStatus(this.db, credential.id, "available", null, null, null);
      logger.info({ id: credential.id }, "stale lease released");
    }
    return stale.length;
  }

  /** Start periodic cleanup of expired cooldowns and stale leases. */
  startCleanup(intervalMs: number = 60_000): void {
    this.cleanupTimer = setInterval(() => {
      void this.recoverExpiredCooldowns();
      void this.cleanupStaleLeases();
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
