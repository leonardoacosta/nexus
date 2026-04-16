import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const sessionTokenTurns = pgTable(
  "session_token_turns",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sessionId: text("session_id").notNull(),
    ts: timestamp("ts", { mode: "date", withTimezone: true }).notNull(),
    model: text("model").notNull(),
    serviceTier: text("service_tier"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheCreationInputTokens: integer("cache_creation_input_tokens")
      .notNull()
      .default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens")
      .notNull()
      .default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    /** FK to credentials.id (not enforced via Drizzle references to avoid Neon issues) */
    credentialId: text("credential_id"),
    /** Denormalized from credentials.fingerprint for aggregation without JOIN */
    credentialFingerprint: text("credential_fingerprint"),
  },
  (table) => [
    uniqueIndex("session_token_turns_session_ts_uniq").on(
      table.sessionId,
      table.ts,
    ),
    index("session_token_turns_fp_ts_idx").on(
      table.credentialFingerprint,
      table.ts,
    ),
    index("session_token_turns_session_idx").on(table.sessionId),
  ],
);
