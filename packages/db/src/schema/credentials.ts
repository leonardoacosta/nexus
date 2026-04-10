import { relations } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agents } from "./agents";

export const credentials = pgTable("credentials", {
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
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const credentialsRelations = relations(credentials, ({ one }) => ({
  agent: one(agents, {
    fields: [credentials.agentId],
    references: [agents.id],
  }),
}));
