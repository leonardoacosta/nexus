import { relations } from "drizzle-orm";
import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { agents } from "./agents";

/**
 * Per-agent ElevenLabs credential + voice configuration.
 *
 * Mirrors the Anthropic `credentials` table's encryption-at-rest pattern:
 * the API key is stored as AES-256-GCM ciphertext in `valueEncrypted` using
 * the `encrypt`/`decrypt` helpers in `apps/agent/src/credentials/encryption.ts`.
 * Voice metadata is stored plain text.
 *
 * One row per agent (unique index on `agent_id`). Deleting an agent cascades
 * to its credential row — unlike the shared Anthropic pool, an ElevenLabs key
 * is private to a single agent and has no shared-pool fallback.
 */
export const elevenlabsCredentials = pgTable(
  "elevenlabs_credentials",
  {
    id: text("id").primaryKey(),
    /** Owning agent. Private to this agent; no shared pool. */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** AES-256-GCM ciphertext: base64(nonce || ciphertext || authTag). */
    valueEncrypted: text("value_encrypted"),
    /** Identifies which key version encrypted this value; supports future rotation. */
    encryptionKeyId: text("encryption_key_id").default("v1"),
    /** ElevenLabs voice id (plain text). */
    voiceId: text("voice_id"),
    /** Human-readable voice name for display (plain text). */
    voiceName: text("voice_name"),
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
    uniqueIndex("elevenlabs_credentials_agent_id_unique").on(table.agentId),
  ],
);

export const elevenlabsCredentialsRelations = relations(
  elevenlabsCredentials,
  ({ one }) => ({
    agent: one(agents, {
      fields: [elevenlabsCredentials.agentId],
      references: [agents.id],
    }),
  }),
);

export type ElevenlabsCredential = typeof elevenlabsCredentials.$inferSelect;
export type NewElevenlabsCredential = typeof elevenlabsCredentials.$inferInsert;
