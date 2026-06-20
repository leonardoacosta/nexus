/**
 * improvement_ledger — system-of-record for cc workflow:improve / workflow:evolve
 * experiment outcomes (per add-metrics-system-of-record, Phase 1).
 *
 * One row per improvement hypothesis: domain + variants tested, suite results,
 * the verdict, and (later) the observed outcome once the change has been live
 * long enough to judge. cc producers write these cross-repo via a least-priv
 * `cc_metrics` role; nx owns the schema.
 *
 * Stable `id` (text) enables idempotent drain: INSERT ... ON CONFLICT (id) DO
 * UPDATE. The `outcome` jsonb starts NULL and is upserted later (additive
 * last-writer-wins on a known row).
 *
 * jsonb for the nested/variable blocks (thresholds, variants, suite_results,
 * score, baseline, tool_version, outcome) keeps the schema stable as the record
 * shape evolves; only the fields Grafana trends/alerts on are promoted to
 * typed columns.
 */

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const improvementLedger = pgTable(
  "improvement_ledger",
  {
    id: text("id").primaryKey(),
    domain: text("domain"),
    repo: text("repo"),
    targetLayer: text("target_layer"),
    verdict: text("verdict"),
    rationale: text("rationale"),
    ref: text("ref"),
    source: text("source"),
    confidence: text("confidence"),
    lowerIsBetter: boolean("lower_is_better"),
    ts: timestamp("ts", { mode: "date", withTimezone: true }),
    thresholds: jsonb("thresholds"),
    variants: jsonb("variants"),
    suiteResults: jsonb("suite_results"),
    score: jsonb("score"),
    baseline: jsonb("baseline"),
    toolVersion: jsonb("tool_version"),
    /** Observed outcome, written later once the change is judged. Nullable. */
    outcome: jsonb("outcome"),
  },
  (table) => [
    index("improvement_ledger_ts_idx").on(table.ts),
    index("improvement_ledger_source_idx").on(table.source),
    index("improvement_ledger_verdict_idx").on(table.verdict),
  ],
);

export type ImprovementLedger = typeof improvementLedger.$inferSelect;
export type NewImprovementLedger = typeof improvementLedger.$inferInsert;
