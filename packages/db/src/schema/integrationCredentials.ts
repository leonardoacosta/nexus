import { relations } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { agents } from "./agents";

/**
 * Per-agent, per-provider integration credential.
 *
 * A generic registry row keyed by `(agent_id, provider)`: `provider` is a
 * registry key (e.g. "telegram") resolved against `PROVIDER_DESCRIPTORS` in
 * `apps/agent/src/integrations/registry.ts`.
 *
 * Mirrors the ElevenLabs / Anthropic `credentials` encryption-at-rest pattern:
 * the secret is stored as AES-256-GCM ciphertext in `valueEncrypted` using the
 * `encrypt`/`decrypt` helpers in `apps/agent/src/credentials/encryption.ts`.
 * Provider-specific non-secret fields (e.g. Telegram `chatId`) live in the
 * plain-text `metadata` jsonb; the shape is narrowed via `packages/core` types
 * at the application layer.
 *
 * One row per (agent, provider) — unique index on `(agent_id, provider)`.
 * Deleting an agent cascades to its credential rows.
 */
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    id: text("id").primaryKey(),
    /** Registry key identifying the provider, e.g. "telegram". */
    provider: text("provider").notNull(),
    /** Owning agent. Private to this agent; cascades on agent delete. */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** AES-256-GCM ciphertext: base64(nonce || ciphertext || authTag). */
    valueEncrypted: text("value_encrypted"),
    /** Identifies which key version encrypted this value; supports future rotation. */
    encryptionKeyId: text("encryption_key_id").default("v1"),
    /** Provider-specific non-secret fields; narrowed in `packages/core`. */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Wall-clock of the last successful "Test connection" probe. */
    lastTestOkAt: timestamp("last_test_ok_at", { mode: "date" }),
    /** HTTP status code from the most recent test probe. */
    lastTestStatusCode: integer("last_test_status_code"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("integration_credentials_agent_provider_unique").on(
      table.agentId,
      table.provider,
    ),
  ],
);

export const integrationCredentialsRelations = relations(
  integrationCredentials,
  ({ one }) => ({
    agent: one(agents, {
      fields: [integrationCredentials.agentId],
      references: [agents.id],
    }),
  }),
);

export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type NewIntegrationCredential =
  typeof integrationCredentials.$inferInsert;
