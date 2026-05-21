import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { agents } from "./agents";

export const credentials = pgTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    /** AES-256-GCM ciphertext: base64(nonce || ciphertext || authTag) */
    valueEncrypted: text("value_encrypted"),
    /** Identifies which key version encrypted this value; supports future rotation. */
    encryptionKeyId: text("encryption_key_id").default("v1"),
    /**
     * Owning agent for this credential.
     *
     * NULL = shared across all agents (global pool, current implicit behavior).
     * Non-null = credential is private to that specific agent.
     *
     * ON DELETE SET NULL: deleting an agent promotes its private credentials
     * back to the shared pool rather than destroying them.
     */
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("available"),
    leasedBy: text("leased_by"),
    leasedAt: timestamp("leased_at", { mode: "date" }),
    cooldownUntil: timestamp("cooldown_until", { mode: "date" }),
    /** Cumulative rate-limit hit count; used for weighted round-robin lease selection. */
    rateLimitCount: integer("rate_limit_count").notNull().default(0),
    /**
     * Stable identity key derived from the OAuth refresh token.
     *
     * Computed as lowercase-hex SHA-256 of `claudeAiOauth.refreshToken`.
     * Defaults to the empty string purely so the generated migration is
     * append-only against existing rows; the backfill step replaces every
     * empty value with either a real hash or an `UNKNOWN-<id>` sentinel.
     * Application code MUST NOT insert an empty fingerprint — new inserts
     * always compute the hash up front (see credential-identity spec).
     */
    fingerprint: text("fingerprint").notNull().default(""),
    /**
     * Duplicate-group identifier. In steady state this equals `fingerprint`;
     * duplicates (rows sharing a refresh token) share a single
     * `duplicate_group_id`. Nullable until the backfill step completes.
     */
    duplicateGroupId: text("duplicate_group_id"),
    /**
     * Exactly one row per duplicate group is leaseable. Non-primary rows stay
     * visible in the API but are excluded from `CredentialPool.lease()`.
     */
    isPrimary: boolean("is_primary").notNull().default(false),
    /** Anthropic subscription tier: "max", "team", "pro", etc. Extracted from decrypted OAuth blob. */
    subscriptionType: text("subscription_type"),
    /** Anthropic rate-limit tier: "default_claude_max_5x", "default_claude_max_20x", etc. */
    rateLimitTier: text("rate_limit_tier"),
    /** OAuth access token expiry. Extracted from claudeAiOauth.expiresAt (epoch ms → timestamptz). */
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    /** Anthropic account email from /api/oauth/profile. */
    accountEmail: text("account_email"),
    /** Anthropic account display name from /api/oauth/profile. */
    accountName: text("account_name"),
    /** Anthropic account UUID from /api/oauth/profile. */
    accountUuid: text("account_uuid"),
    /** Anthropic organization name from /api/oauth/profile. */
    orgName: text("org_name"),
    /** Anthropic organization UUID from /api/oauth/profile. */
    orgUuid: text("org_uuid"),
    /** Comma-separated MCP provider names extracted from mcpOAuth keys (e.g. "figma,posthog,slack"). */
    mcpProviders: text("mcp_providers"),
    /**
     * Latest Anthropic /api/oauth/usage snapshot (5-hour window + 7-day window).
     *
     * Populated by `credential-usage-poller.ts` every 5 minutes for rows where
     * `is_primary = true AND status = 'available'`. All NULL until the first
     * successful poll. The poller never clobbers a populated row on parse /
     * network failure — older data is left in place until a fresh sample lands.
     */
    usage5hUsed: integer("usage_5h_used"),
    usage5hLimit: integer("usage_5h_limit"),
    usage5hResetAt: timestamp("usage_5h_reset_at", {
      mode: "date",
      withTimezone: true,
    }),
    usage7dUsed: integer("usage_7d_used"),
    usage7dLimit: integer("usage_7d_limit"),
    usage7dResetAt: timestamp("usage_7d_reset_at", {
      mode: "date",
      withTimezone: true,
    }),
    /** Wall-clock at which the poller last wrote the usage snapshot above. */
    usagePolledAt: timestamp("usage_polled_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("credentials_fingerprint_idx").on(table.fingerprint),
    index("credentials_group_primary_idx").on(
      table.duplicateGroupId,
      table.isPrimary,
    ),
  ],
);

export const credentialsRelations = relations(credentials, ({ one }) => ({
  agent: one(agents, {
    fields: [credentials.agentId],
    references: [agents.id],
  }),
}));
