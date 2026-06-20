/**
 * cc_decision — system-of-record for cc adoption-signal decisions, the PG
 * migration target for the old git-tracked decisions.json
 * (per add-metrics-system-of-record, Phase 1).
 *
 * One row per signal (`signal_id` pk). `research` holds the captured research
 * block; `history` is an append-only verdict log (jsonb array) so a signal's
 * decision evolution is preserved across re-evaluations. Drain upserts on
 * `signal_id` (INSERT ... ON CONFLICT (signal_id) DO UPDATE), and `history`
 * append is additive last-writer-wins on a known row.
 */

import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const ccDecision = pgTable(
  "cc_decision",
  {
    signalId: text("signal_id").primaryKey(),
    area: text("area"),
    title: text("title"),
    officialSource: text("official_source"),
    version: text("version"),
    firstSeen: timestamp("first_seen", { mode: "date", withTimezone: true }),
    research: jsonb("research"),
    /** Append-only verdict log. */
    history: jsonb("history"),
  },
  (table) => [index("cc_decision_area_idx").on(table.area)],
);

export type CcDecision = typeof ccDecision.$inferSelect;
export type NewCcDecision = typeof ccDecision.$inferInsert;
