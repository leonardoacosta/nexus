/**
 * credential_swaps — per-session credential rotation history.
 *
 * Each row records one rotation event: the credential pool swapped a session
 * from one credential identity (`from_fingerprint`) to another
 * (`to_fingerprint`) for a stated `reason` (cooldown / exhaustion / manual /
 * etc.). This makes swap behaviour auditable — without it, rotation was a
 * black box (see credential-pool-correctness § Why).
 *
 * Identity columns use the credential `fingerprint` (lowercase-hex SHA-256 of
 * the OAuth refresh token), mirroring the denormalized `credential_fingerprint`
 * columns on `sessions` / `session_token_turns`. Like those tables, the
 * session/credential relationships are NOT enforced via Drizzle `references`
 * to avoid Neon FK issues. `from_fingerprint` is nullable so the first
 * assignment to a session (no prior credential) can be recorded.
 *
 * Spec: openspec/changes/credential-pool-correctness
 */

import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Why a swap happened — narrowed at the application layer. */
export const CREDENTIAL_SWAP_REASONS = [
  "cooldown",
  "exhaustion",
  "manual",
  "expired",
  "initial",
] as const;
export type CredentialSwapReason = (typeof CREDENTIAL_SWAP_REASONS)[number];

export const credentialSwaps = pgTable(
  "credential_swaps",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** CC session the swap happened in. Mirrors sessions.id (text, unenforced FK). */
    sessionId: text("session_id").notNull(),
    /**
     * Credential identity swapped FROM. NULL when this is the session's first
     * credential assignment (no prior credential to swap away from).
     */
    fromFingerprint: text("from_fingerprint"),
    /** Credential identity swapped TO. Always present — a swap targets a credential. */
    toFingerprint: text("to_fingerprint").notNull(),
    /** "cooldown" | "exhaustion" | "manual" | "expired" | "initial". */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("credential_swaps_session_created_at_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    index("credential_swaps_created_at_idx").on(table.createdAt),
  ],
);

export type CredentialSwap = typeof credentialSwaps.$inferSelect;
export type NewCredentialSwap = typeof credentialSwaps.$inferInsert;
