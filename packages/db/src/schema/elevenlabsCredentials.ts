/**
 * ElevenLabs per-agent credential row.
 *
 * Mirrors the encryption-at-rest pattern from `credentials.ts`: the API key is
 * stored as AES-256-GCM ciphertext in `value_encrypted` (base64 of nonce ||
 * ciphertext || authTag). Voice metadata (`voice_id`, `voice_name`) is stored
 * as plain text alongside the key so the dashboard can render the current
 * selection without an extra round-trip to ElevenLabs.
 *
 * One row per agent (UNIQUE on `agent_id`). Cascade-deletes when the agent is
 * removed. Used by `apps/agent/src/notifications/channels/tts.ts` to prefer
 * the DB-managed key over `process.env.ELEVENLABS_API_KEY`.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 */

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { agents } from "./agents";

export const elevenlabsCredentials = pgTable(
  "elevenlabs_credentials",
  {
    id: text("id").primaryKey(),
    /**
     * Owning agent for this credential. One row per agent.
     *
     * ON DELETE CASCADE: deleting an agent removes its ElevenLabs credential
     * row. This is intentional — credentials are per-agent and have no
     * meaning without their owning agent.
     */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * AES-256-GCM ciphertext of the ElevenLabs API key:
     * base64(nonce || ciphertext || authTag).
     *
     * Nullable so DELETE-key-only operations (clear key but keep voice
     * selection) can null this column without dropping the row.
     */
    valueEncrypted: text("value_encrypted"),
    /** Identifies which key version encrypted this value; supports future rotation. */
    encryptionKeyId: text("encryption_key_id").default("v1"),
    /** ElevenLabs voice id (e.g., "21m00Tcm4TlvDq8ikWAM"). Plain text. */
    voiceId: text("voice_id"),
    /** Human-readable voice name cached from /v1/voices for display. */
    voiceName: text("voice_name"),
    /** Wall-clock time of the last successful test probe against /v1/user. */
    lastTestOkAt: timestamp("last_test_ok_at", { mode: "date" }),
    /** HTTP status code returned by the most recent /v1/user probe. */
    lastTestStatusCode: integer("last_test_status_code"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("elevenlabs_credentials_agent_id_unique").on(table.agentId),
    index("elevenlabs_credentials_agent_id_idx").on(table.agentId),
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
export type NewElevenlabsCredential =
  typeof elevenlabsCredentials.$inferInsert;
