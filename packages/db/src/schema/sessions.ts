import { relations } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  integer,
  timestamp,
  real,
  doublePrecision,
  uuid,
} from "drizzle-orm/pg-core";

import { agents } from "./agents";
import { projects } from "./projects";

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    machine: text("machine").notNull(),
    status: text("status").notNull().default("active"),
    startedAt: timestamp("started_at", { mode: "date" }).notNull(),
    lastActivity: timestamp("last_activity", { mode: "date" }).notNull(),
    endedAt: timestamp("ended_at", { mode: "date" }),
    pid: integer("pid"),
    cwd: text("cwd"),

    // Extended fields — added in migration 0005
    branch: text("branch"),
    sessionType: text("session_type"),
    model: text("model"),
    rateLimitUtilization: real("rate_limit_utilization"),
    totalCostUsd: doublePrecision("total_cost_usd"),
    rateLimitResetAt: timestamp("rate_limit_reset_at", { mode: "date" }),
    idleSince: timestamp("idle_since", { mode: "date" }),
    ccSessionId: text("cc_session_id"),
    tmuxSession: text("tmux_session"),
    tmuxTarget: text("tmux_target"),
    spec: text("spec"),

    // Token-stream fields — added in session-token-stream change
    /** FK to credentials.id (not enforced via Drizzle references to avoid Neon issues) */
    credentialId: text("credential_id"),
    /** Denormalized from credentials.fingerprint for aggregation without JOIN */
    credentialFingerprint: text("credential_fingerprint"),

    // Git origin fields — added by add-git-project-resolver.
    /** Provider host extracted from `git remote get-url origin`. */
    gitProvider: text("git_provider"),
    /** Owner/repo path (e.g. "leonardoacosta/nexus") extracted from origin. */
    gitOwnerRepo: text("git_owner_repo"),

    // Agent-state field — added by session-enrichment. Orthogonal to the
    // lifecycle `status` axis. Nullable + no default (additive, backward-
    // compatible: absence renders as today's behavior). One of
    // `blocked` | `waiting` | `ready`, derived from the CC hook stream.
    agentState: text("agent_state"),

    // Sub-agent tree fields — added by add-subagent-tree-columns.
    /**
     * Parent session id when this session was spawned by another agent
     * (CC `agent_spawn` event with `parent_agent` set). Self-referential FK;
     * NULL for top-level sessions. ON DELETE SET NULL preserves child rows
     * if the parent is purged.
     */
    parentSessionId: text("parent_session_id"),
    /**
     * Free-form role label from CC `agent_spawn` events (e.g. "explore",
     * "verify"). Indexed only via the tree-rendering query plan; analytics
     * may also group by this column.
     */
    childRole: text("child_role"),
  },
  (table) => [
    // Supports the process-watcher reconciliation query, which selects open
    // session rows on this machine (status = 'active' AND ended_at IS NULL)
    // and joins them against running PIDs from `pgrep -af claude`. Without
    // the composite, the planner falls back to a full scan once the table
    // grows past a few thousand rows.
    index("sessions_status_ended_pid_idx").on(
      table.status,
      table.endedAt,
      table.pid,
    ),
    // Supports the tree-query "list all children of session X". Without
    // this index, the planner full-scans `sessions` once the table grows.
    index("sessions_parent_session_id_idx").on(table.parentSessionId),
  ],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  project: one(projects, {
    fields: [sessions.projectId],
    references: [projects.id],
  }),
  agent: one(agents, {
    fields: [sessions.machine],
    references: [agents.id],
  }),
}));
