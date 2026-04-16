import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const sessionTokenWatcherState = pgTable(
  "session_token_watcher_state",
  {
    sessionId: text("session_id").primaryKey(),
    transcriptPath: text("transcript_path").notNull(),
    byteOffset: bigint("byte_offset", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
);
