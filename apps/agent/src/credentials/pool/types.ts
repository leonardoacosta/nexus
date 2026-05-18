import type { CredentialRow } from "../store";

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

/** Result of a manual credential swap. */
export type ManualSwapResult = {
  /** The credential that was parked on cooldown (null if target was already best-available). */
  parked: CredentialRow | null;
  /** The target credential that is now the preferred available credential. */
  activated: CredentialRow;
};

/**
 * Trimmed credential representation nested under a primary's `duplicates`
 * array in the `GET /credentials` response. Intentionally excludes
 * `valueEncrypted`, `leasedBy`, `cooldownUntil`, and any other field that
 * could leak token material or operational state of a non-primary row.
 */
export interface CredentialDuplicateEntry {
  id: string;
  name: string;
  fingerprint: string;
  duplicateGroupId: string | null;
  isPrimary: boolean;
  status: string;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  expiresAt: Date | null;
  accountEmail: string | null;
  accountName: string | null;
  accountUuid: string | null;
  orgName: string | null;
  orgUuid: string | null;
  mcpProviders: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Top-level entry returned by `CredentialPool.list()`. Primary entries
 * carry a `duplicates` array of their non-primary siblings; non-primary
 * entries omit the field entirely.
 */
export type CredentialListEntry = Omit<CredentialRow, "valueEncrypted"> & {
  duplicates?: CredentialDuplicateEntry[];
};
