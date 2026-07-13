---
status: draft
---

# Proposal: Session-Keyed Context-Window API (replaces pane-keyed cc-tmux cache)

## Change ID
`add-session-context-api`

## Summary
Consolidate nexus-statusline's two overlapping per-render context-window caches —
`session-context.<pane>.json` (tmux-pane-keyed, written for cc-tmux's session-bar row) and
`statusline-ctx.<sessionId>.json` (session-id-keyed, internal-only spurious-zero guard) — and
expose the session-id-keyed data through a new nx-agent HTTP surface,
`GET /sessions/:id/context`, so any consumer that knows a CC session's id — cc-tmux running
locally, or nx's own dashboard/Swift clients querying a *different* machine's agent — can read
current context-window usage. The pane-keyed file is dropped entirely (clean replacement, not a
compat shim); nx stays pane-agnostic by design, matching its existing architecture (confirmed:
zero tmux-pane references anywhere in `apps/agent`, `packages/db`, or `packages/core`).

## Context
- Extends: `apps/nexus-statusline/src/context-guard.ts` (existing session-id-keyed spurious-zero
  guard — its local file + logic stay; a new fire-and-forget push to nx-agent is added alongside)
- Extends: `apps/nexus-statusline/src/session-context.ts` (the tmux-pane-keyed writer — deleted)
- Extends: `apps/agent/src/server-request-handler.ts` (new route group registration, same
  delegation pattern as `tryHandleElevenlabsRoute`)
- Related: `apps/agent/src/routes/elevenlabs-voices.ts` (in-memory `Map` + TTL cache precedent —
  mirrored here for the new session-context store; this data is ephemeral render-time state, not
  a fit for a Postgres table given per-render write frequency)
- Related: cc-tmux plugin (`~/.claude` plugin cache, `cc_tmux/registry.py`) — tracks **zero**
  session-id state today (pane-only). Teaching it to capture `session_id` from CC's hook payload
  and query the new endpoint is explicitly OUT OF SCOPE for this proposal (separate repo/plugin,
  own release cadence) — tracked as a follow-up bead, not a tasks.md task here.
- touches: `apps/agent/src/routes/session-context.ts`, `apps/agent/src/server-request-handler.ts`, `apps/nexus-statusline/src/context-guard.ts`, `apps/nexus-statusline/src/session-context.ts`, `apps/nexus-statusline/src/index.ts`, `packages/core/src/types/session-context.ts`, `packages/core/src/index.ts`

## Motivation
Two files hold the same underlying value (context-window used %) today, keyed two different
ways, for two different reasons that happen to overlap:

1. `session-context.ts` writes `session-context.<pane>.json`, keyed by `$TMUX_PANE`, purely so
   cc-tmux's session-bar row can read a context-window percentage. It has no other consumer.
2. `context-guard.ts` writes `statusline-ctx.<sessionId>.json`, keyed by CC's own `session_id`,
   purely as nexus-statusline's own internal guard against CC's spurious `used_percentage: 0`
   frames (design.md §1) — never read by anything outside this process.

Neither file is queryable across machines, and neither is the "real" canonical source — they're
two write-only side effects of the same render loop. Meanwhile nx's actual architecture already
aggregates session state across machines via nx-agent (hook ingest → socket-server → dispatcher);
context-window usage is the one piece of session state that never reaches nx-agent at all, because
`context_window`/`rate_limits` are exclusive to the statusLine hook payload — confirmed against
the official Claude Code hooks reference: none of the other 30 documented hook events (PreToolUse,
PostToolUse, Stop, etc.) carry this data. nexus-statusline is the only process that ever sees it.

Consolidating onto session_id (CC's stable, globally-unique session identifier — not a tmux pane,
which gets recycled across unrelated sessions over a machine's uptime) and pushing it into
nx-agent turns this from "a file only the same tmux pane can find" into "queryable session state,
consistent with how nx already treats every other piece of session data."

## Requirements

### Requirement: nx-agent SHALL maintain an in-memory, session-id-keyed context-window store
A new in-memory `Map<sessionId, { usedPercentage, contextWindowSize, updatedAt }>` in the agent
process, mirroring `apps/agent/src/routes/elevenlabs-voices.ts`'s cache-with-TTL pattern. Entries
older than 600 seconds (matching `context-guard.ts`'s existing `CTX_FRESH_WINDOW_SECS` freshness
convention) are treated as absent. NOT persisted to Postgres — this is ephemeral, per-render-frequency
state; a durable row would mean a DB write on every statusline render, which is both unnecessary
(fresh data arrives within seconds of the next render after a restart) and inconsistent with how
transient state is handled elsewhere in this codebase (in-memory caches, not tables, for
data with no historical-query need).

#### Scenario: Fresh entry returned
Given a POST wrote `{usedPercentage: 42, contextWindowSize: 200000}` for session "abc" 30 seconds ago
When the store is queried for session "abc"
Then the entry is returned as fresh

#### Scenario: Stale entry treated as absent
Given a POST wrote an entry for session "abc" 700 seconds ago
When the store is queried for session "abc"
Then the entry is treated as absent (same as no entry ever existed)

### Requirement: nx-agent MUST expose POST /sessions/:id/context to update the store
Accepts `{ usedPercentage: number, contextWindowSize?: number }`. Validates `usedPercentage` is a
finite number in `[0, 100]`; contextWindowSize when present is a positive integer. Writes/overwrites
the in-memory entry for `:id` with the current timestamp. Returns `204` on success, `400` on invalid
body. No `x-nexus-secret` gate — reach is bounded at the bind layer (loopback + Tailscale only),
matching the ElevenLabs/integration-credentials route convention.

#### Scenario: Valid update
Given no prior entry exists for session "abc"
When `POST /sessions/abc/context` is called with `{usedPercentage: 15}`
Then the response is 204 and a subsequent GET returns `{usedPercentage: 15, ...}`

#### Scenario: Invalid body rejected
Given any prior state
When `POST /sessions/abc/context` is called with `{usedPercentage: "not-a-number"}`
Then the response is 400 and the store is unchanged

### Requirement: nx-agent MUST expose GET /sessions/:id/context to query the store
Returns `{ sessionId, usedPercentage, contextWindowSize, updatedAt }` (ISO 8601) for a fresh entry,
or `404 {"error": "no context data for session"}` for an absent or stale one. Queryable by any
caller reachable at the agent's bind address — same machine (cc-tmux, once its own follow-up
lands) or a different machine on the tailnet (nx's dashboard/Swift clients).

#### Scenario: Fresh session found
Given a fresh entry exists for session "abc"
When `GET /sessions/abc/context` is called
Then the response is 200 with the entry's current shape

#### Scenario: Unknown or stale session
Given no fresh entry exists for session "xyz"
When `GET /sessions/xyz/context` is called
Then the response is 404 `{"error": "no context data for session"}`

### Requirement: nexus-statusline SHALL push its resolved context-window reading to nx-agent on every render
After `context-guard.ts`'s existing spurious-zero-guard logic resolves a value (unchanged — the
local `statusline-ctx.<sessionId>.json` snapshot and its guard behavior are NOT modified by this
proposal), fire an async, non-awaited `POST /sessions/:id/context` to the local nx-agent with the
resolved `{usedPercentage, contextWindowSize}`. This MUST NOT block or delay the statusline render
in any way — fire-and-forget, matching this codebase's established fail-soft/fail-open convention
for every other external call in the render path (the OAuth usage poller, the profile fetch, etc.).
A failed or slow POST (agent down, network hiccup) is silently swallowed; the render already
completed using the locally-resolved value regardless of push outcome.

#### Scenario: Render never blocks on the push
Given nx-agent is unreachable
When the statusline renders and resolves a context value
Then the render completes and prints normally, with no added latency waiting on the POST

#### Scenario: Push carries the resolved (guarded) value, not the raw CC frame
Given CC's raw stdin frame for this render is a spurious `used_percentage: 0`
And the guard resolves the fresh cached snapshot value (`42`) instead
When the push fires
Then the POST body carries `usedPercentage: 42` (the resolved value), never the raw `0`

### Requirement: nexus-statusline SHALL NOT write the tmux-pane-keyed session-context file
`session-context.ts` and its `writeSessionContext()` call site are removed. This is a clean
replacement, not a compat shim — cc-tmux's session-bar context-% segment will read as absent
until cc-tmux's own follow-up (out of scope here) starts querying the new `GET
/sessions/:id/context` endpoint using a session_id it captures itself from CC's hook payload.

#### Scenario: No pane-keyed file is written
Given a statusline render completes with a resolved context value
When the render's side effects are inspected
Then no `session-context.<pane>.json` file is created or updated

#### Scenario: Existing orphaned pane-keyed files still get garbage-collected
Given a pane-keyed file from before this change exists on disk and has aged past its TTL
When the existing `gcSessionContext` opportunistic GC runs
Then the orphaned file is still pruned (the GC's `session-context.` prefix is unchanged — this
proposal stops the writer, not the sweep of pre-existing files)

## Scope
- **IN**: in-memory session-id-keyed context store in nx-agent; `POST`/`GET
  /sessions/:id/context` routes; nexus-statusline pushes its resolved value on every render
  (fire-and-forget); removal of the pane-keyed `session-context.ts` writer.
- **OUT**: any change to cc-tmux itself (separate repo/plugin) — filed as a follow-up bead, not
  built here. cc-tmux's session-bar context-% segment will show stale/absent data until that
  follow-up ships; this is an accepted, explicit tradeoff of the clean-replacement approach.
- **OUT**: persisting context-window history to Postgres — this is live/ephemeral state only, no
  historical query need identified.
- **OUT**: changing `context-guard.ts`'s existing spurious-zero-guard logic or its local file —
  that behavior is unmodified; only a new push call is added alongside it.
- **OUT**: 5h/7d rate-limit usage — already correctly wired (stdin-first, OAuth-poller-fallback,
  `resolveUsage()` in `usage.ts`) and out of scope for this change.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| nx-agent session-context store (TTL fresh/stale, Map semantics) | [2.1] | N/A — no user-facing flow beyond the route layer |
| `POST`/`GET /sessions/:id/context` routes (validation, 404, 204) | [2.2] | N/A — no user-facing flow |
| `context-guard.ts` push behavior (non-blocking, carries resolved not raw value, guard logic unchanged) | [3.1] | N/A — statusline render path, no Playwright surface |
| `session-context.ts` removal (no pane file written; GC still sweeps orphans) | [3.2] | N/A — no user-facing flow |

## Impact
| Area | Change |
|------|--------|
| `apps/agent` | New in-memory session-context store + `routes/session-context.ts` (2 routes) + `server-request-handler.ts` registration |
| `apps/nexus-statusline` | `context-guard.ts` gains a fire-and-forget push; `session-context.ts` deleted; its call site removed from `index.ts` |
| `packages/core` | New `packages/core/src/types/session-context.ts` (shared wire Zod schemas for the POST body / GET response) |
| cc-tmux (external, not built here) | Session-bar context-% segment degrades to absent until its own follow-up ships |

## Risks
| Risk | Mitigation |
|------|-----------|
| Fire-and-forget POST could still add measurable latency if `fetch()` itself blocks before the promise is discarded | Use a short client-side timeout (reuse `FETCH_TIMEOUT_MS` convention from `usage.ts`) on an un-awaited call; the render path never `await`s the push |
| Local agent URL resolution for a same-machine push isn't yet established in nexus-statusline (it has never made an outbound call to its own local agent before) | Task 3.1 resolves this from the existing `~/.config/nexus/agents.toml` / agent-port convention already documented in `.claude/CLAUDE.md`, not a new invention |
| Removing the pane-keyed file breaks cc-tmux's session-bar immediately | Explicit, accepted tradeoff per Scope — clean replacement was the requested approach; follow-up bead tracks the cc-tmux-side fix |
| In-memory store means an nx-agent restart loses all current context data | Acceptable — fresh data repopulates within one render cycle (a few seconds) after restart; this store was never meant to be durable |
