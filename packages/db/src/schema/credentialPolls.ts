import { relations } from "drizzle-orm";
import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

import { credentials } from "./credentials";

/**
 * Append-only time-series of Anthropic credential utilization.
 *
 * Mirrors the `health_snapshots` shape: one row per polled account per
 * successful 5-minute usage poll. Unlike the `credentials` table (which the
 * usage poller overwrites with the latest snapshot each tick), this table
 * retains history so the Mac dashboard can render a utilization trend.
 *
 * Retention: the weekly reaper prunes rows older than 30 days.
 */
export const credentialPolls = pgTable(
  "credential_polls",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    /** Account fingerprint — groups the series by account across credential rows. */
    fingerprint: text("fingerprint").notNull(),
    usage5hUsed: integer("usage_5h_used"),
    usage5hLimit: integer("usage_5h_limit"),
    usage7dUsed: integer("usage_7d_used"),
    usage7dLimit: integer("usage_7d_limit"),
    usage5hResetAt: timestamp("usage_5h_reset_at", {
      mode: "date",
      withTimezone: true,
    }),
    usage7dResetAt: timestamp("usage_7d_reset_at", {
      mode: "date",
      withTimezone: true,
    }),
    polledAt: timestamp("polled_at", { mode: "date", withTimezone: true }).notNull(),
  },
  (table) => [
    index("credential_polls_credential_id_polled_at_idx").on(
      table.credentialId,
      table.polledAt,
    ),
    index("credential_polls_polled_at_idx").on(table.polledAt),
  ],
);

export const credentialPollsRelations = relations(credentialPolls, ({ one }) => ({
  credential: one(credentials, {
    fields: [credentialPolls.credentialId],
    references: [credentials.id],
  }),
}));

export type CredentialPoll = typeof credentialPolls.$inferSelect;
export type NewCredentialPoll = typeof credentialPolls.$inferInsert;
