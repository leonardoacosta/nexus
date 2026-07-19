import { relations } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  integer,
  timestamp,
  real,
  uuid,
  boolean,
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
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull(),
    lastActivity: timestamp("last_activity", { mode: "date", withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }),
    // Stop-reason fields — added by nx-f060f. Nullable + additive
    // (backward-compatible: absence renders as today's behavior). Populated
    // on session stop alongside `ended_at` via `recordSessionStop`.
    stopReason: text("stop_reason"),
    errorDetails: text("error_details"),
    pid: integer("pid"),
    cwd: text("cwd"),

    // Extended fields — added in migration 0005
    branch: text("branch"),
    sessionType: text("session_type"),
    model: text("model"),
    rateLimitUtilization: real("rate_limit_utilization"),
    rateLimitResetAt: timestamp("rate_limit_reset_at", { mode: "date", withTimezone: true }),
    idleSince: timestamp("idle_since", { mode: "date", withTimezone: true }),
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

    // Working-tree git status fields — added by mx-rkir.5. Populated by
    // `services/git-project-resolver.ts#resolveGitStatus` (delegates to the
    // existing `getGitMetadata` cwd-cached resolver in `services/git-project.ts`)
    // alongside the git-origin fields above. Nullable + no default (additive,
    // backward-compatible): null means "not yet resolved for this cwd", NOT
    // "clean and in sync" — consumers must not conflate the two.
    /** Working tree has uncommitted/untracked tracked changes. */
    gitDirty: boolean("git_dirty"),
    /** Commits ahead of the configured upstream. 0 when no upstream / in sync. */
    gitAhead: integer("git_ahead"),
    /** Commits behind the configured upstream. 0 when no upstream / in sync. */
    gitBehind: integer("git_behind"),

    // Monitor-tool classification — added by mx-rkir.5. Orthogonal to
    // `sessionType` (attach-mechanism classification: ad_hoc/managed/pooled) —
    // deliberately NOT folded into that enum, since a Monitor-tool-driven
    // session is still tmux-managed/attach-eligible and overloading
    // `sessionType` would silently break the `sessionType == "managed"` PTY
    // attach gate (apps/swift Dashboard/PtyViewer.swift, Attach/SshTerminalSession.swift).
    // Sticky per-session: set true the first time a `tool_use_end` hook event
    // carries `tool === "Monitor"`, never cleared back to false/null for the
    // life of the session (mirrors the additive, no-clobber shape of
    // `updateSessionAgentState`'s siblings).
    isMonitorSession: boolean("is_monitor_session"),
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
