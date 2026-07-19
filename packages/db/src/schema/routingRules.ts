/**
 * routing_rules — durable, ordered priority rules for the presence-aware
 * notification routing engine.
 *
 * Spec: openspec/changes/context-aware-routing (Phase 1).
 *
 * The rules engine reads these in `priority` order (first-match-wins) and
 * produces a closed `Action`. Persisting them in a table (vs. hardcoding)
 * keeps drag-reorder priority durable and queryable. Mutations broadcast the
 * existing `SettingsChanged` lifecycle event — no new SSE channel.
 *
 * `condition` and `action` are `jsonb` so the schema does not churn as the
 * presence vector / action shape grows across phases; both are narrowed via
 * `packages/core` types at the application layer.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** A rule predicate over the presence vector — narrowed in `packages/core`. */
export type RoutingRuleCondition = Record<string, unknown>;

/** The closed routing action emitted on match — narrowed in `packages/core`. */
export type RoutingRuleAction = Record<string, unknown>;

export const routingRules = pgTable(
  "routing_rules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** Lower = evaluated first (first-match-wins). */
    priority: integer("priority").notNull(),
    condition: jsonb("condition").$type<RoutingRuleCondition>().notNull(),
    action: jsonb("action").$type<RoutingRuleAction>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("routing_rules_user_priority_idx").on(table.userId, table.priority),
  ],
);

export type RoutingRule = typeof routingRules.$inferSelect;
export type NewRoutingRule = typeof routingRules.$inferInsert;
