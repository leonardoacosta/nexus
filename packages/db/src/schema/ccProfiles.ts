/**
 * cc_profiles — Claude Code OAuth profile tracking.
 *
 * Each row represents one observed Claude profile sourced from CC's
 * `~/.claude/credentials.json`. The agent owns writes to that file; this
 * table is the durable mirror used for expiry tracking, rate-limit-aware
 * swap, and per-profile cost attribution.
 *
 * Refresh tokens are stored encrypted (AES-256-GCM, same envelope as
 * `credentials.value_encrypted`).
 *
 * Spec: openspec/changes/add-cc-credential-manager
 */

import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Profile types observed in credentials.json. */
export const CC_PROFILE_TYPES = ["pro", "max", "api_key"] as const;
export type CcProfileType = (typeof CC_PROFILE_TYPES)[number];

/** Rate-limit status surfaced via 429 monitoring + swap. */
export const CC_RATE_LIMIT_STATUSES = [
  "healthy",
  "warning",
  "rate_limited",
] as const;
export type CcRateLimitStatus = (typeof CC_RATE_LIMIT_STATUSES)[number];

export const ccProfiles = pgTable(
  "cc_profiles",
  {
    id: text("id").primaryKey(),
    /** "pro" | "max" | "api_key" — narrow union at the application layer. */
    type: text("type").notNull(),
    /**
     * AES-256-GCM ciphertext of the OAuth refresh token:
     * base64(nonce || ciphertext || authTag).
     * Null for api_key-only profiles that never refresh.
     */
    oauthRefreshTokenEncrypted: text("oauth_refresh_token_encrypted"),
    /** Encryption key version. Mirrors credentials.encryption_key_id. */
    encryptionKeyId: text("encryption_key_id").default("v1"),
    /** Access token expiry; used to drive proactive refresh 5min before. */
    expiryTs: timestamp("expiry_ts", { mode: "date", withTimezone: true }),
    /** Last time this profile was selected by the credential pool. */
    lastUsedTs: timestamp("last_used_ts", { mode: "date", withTimezone: true }),
    /** Cumulative USD attributed to this profile across all sessions. */
    currentCostUsd: doublePrecision("current_cost_usd").notNull().default(0),
    /** "healthy" | "warning" | "rate_limited". */
    rateLimitStatus: text("rate_limit_status").notNull().default("healthy"),
    /** Optional Anthropic account email for display. */
    accountEmail: text("account_email"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("cc_profiles_expiry_ts_idx").on(table.expiryTs),
    index("cc_profiles_rate_limit_status_idx").on(table.rateLimitStatus),
  ],
);

export type CcProfile = typeof ccProfiles.$inferSelect;
export type NewCcProfile = typeof ccProfiles.$inferInsert;
