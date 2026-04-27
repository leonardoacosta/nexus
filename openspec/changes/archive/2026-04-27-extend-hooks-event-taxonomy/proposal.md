---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-04-27T02:53:42-05:00
---
# Proposal: extend-hooks-event-taxonomy

## Change ID
`extend-hooks-event-taxonomy`

## Summary
Extend `handleHooks` in `apps/agent/src/routes/hooks.ts` to recognize and persist the ~22 event types that Claude Code currently emits via `~/.claude/scripts/hooks/telemetry.sh` but that nexus-agent silently drops into its "unknown event" branch. Every event becomes a row in `session_events` (full JSON payload preserved in `metadata`); no schema migration is required. Lifecycle side effects on the `sessions` table are added only where they unambiguously map (e.g. `session_terminate` finalizes status; `post_compact` increments a metadata-tracked counter).

## Context
- Affects: `apps/agent/src/routes/hooks.ts`, `apps/agent/src/routes/hooks.test.ts`, `apps/agent/src/db/sessions.ts` (potential helper extension), `apps/agent/src/db/events.ts` (no change expected)
- Capability: extends `hooks-endpoint` (parent epic `nx-u2m9a`)
- Predecessor: `restore-hooks-event-persistence` (archived `openspec/changes/archive/2026-04-27-restore-hooks-event-persistence/`, commit `436fb37`). That spec restored persistence for 7 event types; this spec adds the remaining ~22.
- Source of truth for event vocabulary: `~/.claude/scripts/hooks/telemetry.sh` — every `json_event …` call defines an `event_type` string the agent must accept.
- Sibling features (BLOCKED on this one):
  - `nx-6irva` `add-hooks-notification-triggers` — routes specific event types to TTS/notifications
  - `nx-mfarp` `add-hooks-sse-fanout` — fans persisted events out via SSE to dashboard subscribers
- Parent feature bead: `nx-h8uxs` (P2). Priority is P2 not P1 because the `/hooks` endpoint already returns 200 for these events (no caller-visible breakage); the cost is observability gaps, not session failures.

## Motivation

### The gap

After `restore-hooks-event-persistence`, the recognized-events whitelist in `apps/agent/src/routes/hooks.ts` is:

```typescript
const RECOGNIZED_EVENTS = new Set([
  "session_start", "session_stop", "stop_failure", "stop_success",
  "session_summary", "session_heartbeat", "diagnostic_ping",
]);
```

Every other `event_type` cc sends — and `telemetry.sh` is the source of truth for what cc sends — falls through to:

```typescript
return jsonResponse(200, { status: "ok", message: `unknown event: ${eventName}` });
```

That branch returns 200 OK, logs an info line, and writes nothing. Cc keeps sending; nexus keeps acknowledging; the `session_events` table never sees the data.

### Empirical evidence (post-restore baseline)

| Symptom | Observation |
|---|---|
| Recognized event types persisted | 7 (whitelist size) |
| Event types `telemetry.sh` actually emits | ~29 (counted from `json_event …` call sites) |
| Coverage gap | ~22 event types silently dropped |
| Caller-visible failure | None — every call still returns 200 |
| Downstream consequences | SSE dashboard sees 7-of-29 event stream; notification triggers can't fire on tool_use_fail / permission_request; agent-spawn telemetry invisible |

### Cross-reference with `telemetry.sh`

Cross-referenced `~/.claude/scripts/hooks/telemetry.sh` against the current whitelist:

**Lifecycle (3 unhandled):** `session_terminate`, `post_compact`, `pre_compact`
**Agents (3 unhandled):** `agent_spawn`, `agent_telemetry`, `agent_complete`
**Tools (2 unhandled):** `tool_use_end`, `tool_use_fail`
**Commands (3 unhandled):** `command_start`, `command_end`, `user_prompt`
**Other (8 unhandled):** `permission_request`, `teammate_idle`, `task_completed`, `instructions_loaded`, `config_change`, `worktree_create`, `worktree_remove`, `notification`
**Operational (1 unhandled):** `hook_failure` (emitted by `_log_hook_failure` for telemetry-handler self-failures)

Total = 20 distinct unhandled types, plus `agent_telemetry` arrives via `PostToolUse` `tool_name=Task` (counted once), and the original brief listed `heartbeat` as separate — but `heartbeat` already maps to the existing `session_heartbeat` whitelist via `_map_hook_event_name` for `PostToolUse` non-Task tools (see telemetry.sh line 309 — emits `event_type=heartbeat`, not `session_heartbeat`).

**Discovered drift to flag:** the on-the-wire `event_type` for the throttled PostToolUse heartbeat is `heartbeat` (singular, no `session_` prefix — see `handle_heartbeat` in `telemetry.sh:697`). The current whitelist contains `session_heartbeat` instead. That means **`heartbeat` is also silently dropped today** — add it to the lifecycle batch alongside `session_terminate` / `post_compact` / `pre_compact`. Filed as Lifecycle requirement scenario.

### Why this matters now

`add-hooks-notification-triggers` (`nx-6irva`) cannot meaningfully route on `tool_use_fail` / `permission_request` until those event types persist. `add-hooks-sse-fanout` (`nx-mfarp`) cannot stream events the agent never wrote. Both are direct downstream consumers; clearing the taxonomy gap unblocks both.

## Requirements

### Requirement: Lifecycle Event Persistence

nexus-agent SHALL recognize and persist the lifecycle events `session_terminate`, `post_compact`, `pre_compact`, and `heartbeat`. Each event SHALL produce one row in `session_events` with the full payload JSON-stringified into `metadata`. `session_terminate` SHALL additionally finalize the parent session row by setting `ended_at = NOW()` and `status = 'ended'` (idempotent on re-receipt).

#### Scenario: session_terminate finalizes a still-active session
- **GIVEN** session `sess-term-1` has `status='active'` and `ended_at=NULL`
- **WHEN** a payload `{hook_event_name: "session_terminate", session_id: "sess-term-1"}` arrives
- **THEN** `session_events` receives a row with `event_type='session_terminate'`
- **AND** the `sessions` row is updated to `status='ended'`, `ended_at=NOW()`
- **AND** the response is HTTP 200

#### Scenario: post_compact persists with compaction context in metadata
- **GIVEN** session `sess-compact-1` is active
- **WHEN** a payload `{hook_event_name: "post_compact", session_id: "sess-compact-1", compaction_count: 3}` arrives
- **THEN** `session_events` receives a row with `event_type='post_compact'` and `metadata` containing the JSON payload
- **AND** subsequent `post_compact` events for the same session keep appending rows (one row per event)

#### Scenario: heartbeat persists despite name divergence
- **GIVEN** cc emits `event_type='heartbeat'` (singular, per `telemetry.sh:697`) — NOT `session_heartbeat`
- **WHEN** the heartbeat payload arrives at `/hooks`
- **THEN** `session_events` receives a row with `event_type='heartbeat'`
- **AND** the agent-side whitelist accepts both `heartbeat` and the legacy `session_heartbeat` for backward compatibility

### Requirement: Agent-Lifecycle Event Persistence

nexus-agent SHALL recognize and persist the agent-lifecycle events `agent_spawn`, `agent_telemetry`, and `agent_complete`. Payload-typed fields (`agent_type`, `agent_name`, `parent_agent`, `child_role`, `model`, `total_tokens`, `tool_uses`, `duration_ms`, `spec`, `wave`, `phase`, `status`) SHALL be preserved verbatim in the `metadata` JSON column. No new table is created in this spec — a dedicated `agent_invocations` table is explicitly deferred to a follow-up.

#### Scenario: agent_spawn persists with full audit fields
- **GIVEN** a payload `{hook_event_name: "agent_spawn", session_id: "sess-1", agent_type: "ui-engineer", agent_name: "ui-engineer-abc", parent_agent: "orchestrator", child_role: "engineer", model: "claude-sonnet-4-5"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='agent_spawn'` and `metadata` containing all six payload fields
- **AND** the response is HTTP 200

#### Scenario: agent_complete persists deregistration
- **GIVEN** a payload `{hook_event_name: "agent_complete", session_id: "sess-1", agent_type: "ui-engineer"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='agent_complete'`

#### Scenario: agent_telemetry persists token + duration metrics
- **GIVEN** a payload `{hook_event_name: "agent_telemetry", session_id: "sess-1", agent_name: "ui-engineer-abc", spec: "extend-hooks-event-taxonomy", wave: "2", phase: "apply", model: "claude-sonnet-4-5", total_tokens: 12450, tool_uses: 8, duration_ms: 23000, status: "success"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='agent_telemetry'` and `metadata` containing all telemetry fields

### Requirement: Tool-Use Event Persistence

nexus-agent SHALL recognize and persist `tool_use_end` and `tool_use_fail`. Both SHALL preserve the full payload as `metadata` JSON. `tool_use_fail` payloads SHALL preserve the `tool`, `error`, `command`, and `duration_ms` fields exactly as emitted.

#### Scenario: tool_use_end persists with tool name and duration
- **GIVEN** a payload `{hook_event_name: "tool_use_end", session_id: "sess-1", tool: "Edit", success: true, duration_ms: 1200}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='tool_use_end'` and `metadata.tool='Edit'`

#### Scenario: tool_use_fail persists error snippet without truncation in storage
- **GIVEN** a payload `{hook_event_name: "tool_use_fail", session_id: "sess-1", tool: "Bash", error: "permission denied", command: "git push", duration_ms: 80}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='tool_use_fail'`
- **AND** `metadata` contains the original `error`, `command`, and `tool` strings (the agent does not re-truncate; whatever telemetry.sh sent is what gets stored)

### Requirement: Command Event Persistence

nexus-agent SHALL recognize and persist `command_start`, `command_end`, and `user_prompt`. Each row SHALL preserve correlation identifiers (`run_id`, `parent_run_id`, `command`) where present. `user_prompt` payloads MAY contain prompt text in `metadata`; storage is verbatim — no redaction in this spec.

#### Scenario: command_start persists run_id for correlation
- **GIVEN** a payload `{hook_event_name: "command_start", session_id: "sess-1", run_id: "run-abc", command: "/apply:all", project: "nx"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='command_start'`
- **AND** `metadata.run_id='run-abc'` so a downstream consumer can join command_start with command_end

#### Scenario: command_end persists status and duration
- **GIVEN** a payload `{hook_event_name: "command_end", session_id: "sess-1", run_id: "run-abc", command: "/apply:all", status: "success", duration_ms: 540000, agent_count: 3, total_tokens: 87654}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='command_end'` and `metadata.status='success'`

#### Scenario: user_prompt persists text verbatim
- **GIVEN** a payload `{hook_event_name: "user_prompt", session_id: "sess-1", project: "nx"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='user_prompt'`

### Requirement: Operational Event Persistence

nexus-agent SHALL recognize and persist the operational events `permission_request`, `teammate_idle`, `task_completed`, `instructions_loaded`, `config_change`, `worktree_create`, `worktree_remove`, `notification`, and `hook_failure`. Each is treated uniformly: append one `session_events` row with the full payload as `metadata`. No `sessions`-table side effect.

#### Scenario: permission_request persists tool name in metadata
- **GIVEN** a payload `{hook_event_name: "permission_request", session_id: "sess-1", tool: "Bash"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='permission_request'` and `metadata.tool='Bash'`

#### Scenario: hook_failure persists handler diagnostics
- **GIVEN** a payload `{hook_event_name: "hook_failure", session_id: "sess-1", handler: "handle_session_stop", event: "session_stop", exit_code: 1, stderr: "stats jq write failed"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='hook_failure'`
- **AND** `metadata.handler='handle_session_stop'` so observability dashboards can surface telemetry self-failure rates

#### Scenario: worktree_create persists without sessions-table mutation
- **GIVEN** a payload `{hook_event_name: "worktree_create", session_id: "sess-1", project: "nx"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='worktree_create'`
- **AND** the parent `sessions` row is NOT mutated (status, ended_at unchanged)

### Requirement: Backward Compatibility for Acknowledge-Only Events

nexus-agent SHALL continue to return HTTP 200 for any payload whose `hook_event_name` is unrecognized after this expansion. Unknown events SHALL log a warn-level line including the unrecognized event name but SHALL NOT produce a `session_events` row. This preserves the post-`restore-hooks-event-persistence` contract that fire-and-forget hook delivery never blocks cc.

#### Scenario: Truly unknown event type still returns 200 with log line
- **GIVEN** a payload `{hook_event_name: "future_event_type_not_yet_invented", session_id: "sess-1"}`
- **WHEN** the handler processes the request
- **THEN** the response is HTTP 200 with `{status: "ok", message: "unknown event: future_event_type_not_yet_invented"}`
- **AND** no `session_events` row is written
- **AND** a warn-level log line is emitted including the event name

## Scope

### In scope
- Add the ~21 missing event types to `RECOGNIZED_EVENTS`
- Extend `HookEventPayload` interface with optional fields each new event type carries (e.g. `tool`, `error`, `command`, `agent_type`, `agent_name`, `run_id`, `status`, `total_tokens`, `tool_uses`, `phase`, `wave`, `spec`, `handler`, `exit_code`, `stderr`)
- Route `session_terminate` to the existing `updateSessionStatus(_, _, "ended")` + `endedAt = NOW()` path that `session_stop` already uses
- Persist `heartbeat` (singular) in addition to legacy `session_heartbeat` to fix the discovered name drift
- One handler-test per new event type asserting (a) HTTP 200, (b) row in `session_events` with correct `event_type`, (c) `metadata` JSON preserves the relevant fields

### Out of scope (explicitly deferred)
- A dedicated `agent_invocations` table joining `agent_spawn`/`agent_complete` pairs by `agent_pid` or `agent_name` — design call belongs to a follow-up spec once query patterns are observed
- Notification routing on persisted events (`nx-6irva` `add-hooks-notification-triggers`)
- SSE fanout of persisted events to dashboard subscribers (`nx-mfarp` `add-hooks-sse-fanout`)
- Prompt-text redaction for `user_prompt` payloads (privacy review needed before redaction policy is set)
- Backfill of historic event volume — events that were dropped before this lands stay dropped

## Impact

| Surface | Change |
|---|---|
| `apps/agent/src/routes/hooks.ts` | `RECOGNIZED_EVENTS` Set grows from 7 to ~28 entries; `HookEventPayload` interface gains ~15 optional fields; `switch` block gains one new case (`session_terminate` reuses `session_stop` finalization); all other event types fall through to the existing append-only path |
| `apps/agent/src/routes/hooks.test.ts` | One new `it()` per event-type cluster (5 batches × 2-3 scenarios ≈ 12 new tests); existing tests untouched |
| `packages/db/src/schema/sessionEvents.ts` | No change — `metadata` is already `text` (JSON-serialized) |
| Database | No migration — net-additive event_type values into existing `text` column |
| Latency | No measurable change — persistence path is identical, just executed for more event types |
| `add-hooks-notification-triggers` | Unblocked — can now route on persisted `tool_use_fail`, `permission_request`, etc. |
| `add-hooks-sse-fanout` | Unblocked — can stream the full event surface, not just 7 lifecycle events |

## Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Event-type name drift between `telemetry.sh` and the agent (e.g. `heartbeat` vs `session_heartbeat`) | Medium — already discovered one instance | Medium — silent data loss | Whitelist accepts both spellings during the migration; spec scenario locks the canonical name; a follow-up TODO updates `telemetry.sh` to emit only the canonical form |
| Volume spike — `tool_use_end` and `heartbeat` are high-frequency events; `session_events` table grows faster than expected | High | Low-Medium — storage cost, not correctness | `session_events` retention is already a separate concern (`packages/db/src/schema/` has no retention column today; flagged in `crates/nexus-agent`'s `retention.ts`). This spec adds rows; the retention story is owned by a separate capability |
| `metadata` JSON-stringification grows unbounded if `tool_use_fail.error` or `user_prompt.prompt` contain large blobs | Medium | Low | telemetry.sh already truncates `error` to 200 chars and `command` to 100 chars at the source; verbatim-store is safe. For `user_prompt` text, accept current risk — redaction is out of scope |
| New `HookEventPayload` fields collide with existing field names (e.g. two events both have `status` with different semantics) | Low | Low | Discriminated union by `hook_event_name` at the type level is overkill for v1; flat optional fields with TS-doc comments noting which event each field applies to is sufficient. Tests pin the exact payload shapes |
| `session_terminate` fires AFTER `session_stop` in some hook configurations, double-finalizing a session | Low | Low | Both paths set `ended_at = NOW()` and `status = 'ended'` — idempotent. Re-finalization simply overwrites with a later timestamp; no row corruption |
