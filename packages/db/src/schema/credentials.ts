import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  /** AES-256-GCM ciphertext: base64(nonce || ciphertext || authTag) */
  valueEncrypted: text("value_encrypted"),
  /** Identifies which key version encrypted this value; supports future rotation. */
  encryptionKeyId: text("encryption_key_id").default("v1"),
  status: text("status").notNull().default("available"),
  leasedBy: text("leased_by"),
  leasedAt: timestamp("leased_at", { mode: "date" }),
  cooldownUntil: timestamp("cooldown_until", { mode: "date" }),
  /** Cumulative rate-limit hit count; used for weighted round-robin lease selection. */
  rateLimitCount: integer("rate_limit_count").notNull().default(0),
});
