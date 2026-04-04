import type { Database } from "bun:sqlite";
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
  private db: Database;
  private cooldownMs: number;
  private leaseTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Database,
    options?: { cooldownMs?: number; leaseTtlMs?: number },
  ) {
    this.db = db;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.leaseTtlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** Add a new credential to the pool. */
  add(credential: {
    id: string;
    name: string;
    type: string;
    value_encrypted: string;
  }): void {
    insertCredential(this.db, {
      ...credential,
      status: "available",
      leased_by: null,
      leased_at: null,
      cooldown_until: null,
    });
    logger.info("credential added to pool", { id: credential.id, name: credential.name });
  }

  /**
   * Lease the next available credential of the given type (round-robin).
   * Returns the credential row or null if the pool is exhausted.
   */
  lease(type: string, leasedBy: string): CredentialRow | null {
    // First, recover any expired cooldowns
    this.recoverExpiredCooldowns();

    // Find first available credential of this type
    const available = queryCredentialsByStatus(this.db, "available").filter(
      (c) => c.type === type,
    );

    if (available.length === 0) {
      logger.warn("credential pool exhausted", { type });
      return null;
    }

    const credential = available[0]!;
    const now = new Date().toISOString();

    updateCredentialStatus(this.db, credential.id, "leased", leasedBy, now, null);

    const updated = getCredentialById(this.db, credential.id);
    logger.info("credential leased", {
      id: credential.id,
      leasedBy,
    });

    return updated;
  }

  /** Release a leased credential back to available. */
  release(id: string): boolean {
    const credential = getCredentialById(this.db, id);
    if (!credential) {
      logger.warn("release failed — credential not found", { id });
      return false;
    }

    if (credential.status !== "leased") {
      logger.warn("release failed — credential not in leased state", {
        id,
        status: credential.status,
      });
      return false;
    }

    updateCredentialStatus(this.db, id, "available", null, null, null);
    logger.info("credential released", { id });
    return true;
  }

  /**
   * Put a credential on cooldown (e.g., after rate limit detection).
   * Returns the next available credential of the same type, or null.
   */
  reportRateLimit(
    id: string,
    leasedBy: string,
  ): { cooledDown: CredentialRow; next: CredentialRow | null } | null {
    const credential = getCredentialById(this.db, id);
    if (!credential) return null;

    const cooldownUntil = new Date(Date.now() + this.cooldownMs).toISOString();
    updateCredentialStatus(this.db, id, "cooldown", null, null, cooldownUntil);

    logger.info("credential on cooldown (rate limited)", {
      id,
      cooldown_until: cooldownUntil,
    });

    const cooledDown = getCredentialById(this.db, id)!;

    // Try to lease the next available credential of the same type
    const next = this.lease(credential.type, leasedBy);

    return { cooledDown, next };
  }

  /** List all credentials with status info (no values exposed). */
  list(): Array<Omit<CredentialRow, "value_encrypted">> {
    return queryAllCredentials(this.db).map(({ value_encrypted: _, ...rest }) => rest);
  }

  /** Recover credentials whose cooldown has expired. */
  recoverExpiredCooldowns(): number {
    const expired = queryExpiredCooldowns(this.db);
    for (const credential of expired) {
      updateCredentialStatus(this.db, credential.id, "available", null, null, null);
      logger.info("credential recovered from cooldown", { id: credential.id });
    }
    return expired.length;
  }

  /** Clean up stale leases (leased longer than TTL). */
  cleanupStaleLeases(): number {
    const threshold = new Date(Date.now() - this.leaseTtlMs).toISOString();
    const stale = queryStaleLeases(this.db, threshold);
    for (const credential of stale) {
      updateCredentialStatus(this.db, credential.id, "available", null, null, null);
      logger.info("stale lease released", { id: credential.id });
    }
    return stale.length;
  }

  /** Start periodic cleanup of expired cooldowns and stale leases. */
  startCleanup(intervalMs: number = 60_000): void {
    this.cleanupTimer = setInterval(() => {
      this.recoverExpiredCooldowns();
      this.cleanupStaleLeases();
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
