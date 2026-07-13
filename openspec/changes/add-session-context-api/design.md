# Design: Session-Keyed Context-Window API

## Why a design doc
Spans three systems (nx-agent's new HTTP surface, nexus-statusline's push side, shared wire
types) and makes an explicit non-obvious call (in-memory, not Postgres) that future readers of
this capability should not have to re-derive.

## Data flow

```
CC (statusLine hook payload, once per render)
   │  { context_window: { used_percentage, context_window_size }, session_id, ... }
   ▼
nexus-statusline (apps/nexus-statusline)
   │  context-guard.ts resolveContext() — UNCHANGED spurious-zero guard,
   │  local statusline-ctx.<sessionId>.json snapshot stays exactly as it is today
   ▼
   fire-and-forget POST http://<local-agent>/sessions/:id/context   ◄── NEW
   │  { usedPercentage, contextWindowSize }
   ▼
nx-agent (apps/agent) — in-memory Map<sessionId, {usedPercentage, contextWindowSize, updatedAt}>
   │  600s TTL, mirrors elevenlabs-voices.ts's cache-with-TTL shape
   ▼
GET /sessions/:id/context   ◄── NEW, queryable by anyone reachable at the agent's bind address
   │
   ├── cc-tmux (same machine, once its own follow-up captures session_id and queries this)
   └── nx dashboard / Swift clients (any machine on the tailnet, querying a DIFFERENT machine's session)
```

## Why in-memory, not Postgres

This is per-render-frequency data (every statusline draw, roughly every message and on several
UI events per the official hooks docs — debounced 300ms). A durable `sessions` table column
updated at that frequency would be a meaningful write-amplification source for zero query-history
benefit — nobody needs "what was session X's context usage 20 minutes ago," only "what is it
right now." The existing precedent in this codebase for exactly this shape (small, TTL-bound,
frequently-refreshed, no historical value) is `apps/agent/src/routes/elevenlabs-voices.ts`'s
in-memory `Map` cache — mirrored here rather than inventing a new pattern.

An nx-agent restart drops the whole map. This is fine: the next statusline render (within a few
seconds, worst case) repopulates the entry via the same push path. No recovery logic needed.

## Why session_id, not tmux pane

CC's `session_id` is the stable, globally-unique identifier for one Claude Code conversation —
issued once, unchanged for the session's lifetime, and present on every hook payload (including
the statusLine one). A tmux `pane_id` (`%3`, `%17`, ...) is a *terminal multiplexer* concept: the
same pane gets reused across completely unrelated CC sessions over a machine's uptime as panes
open and close, and it has no meaning at all off the machine that owns that tmux server. Keying
on session_id is both more correct (matches the actual entity being described) and strictly more
capable (works cross-machine, which is nx's whole reason for existing) than keying on pane.

## Push mechanism: fire-and-forget, not fire-and-await

The statusline render path has a tight latency budget — CC gates its own UI on this render
completing. Every existing external call in this render path (`fetchWithToken` in `usage.ts`, the
profile fetch) already follows a strict "never let this block or fail the render" discipline
(short timeout, swallow all errors, degrade to omitted segment). The new push to nx-agent follows
the exact same discipline: kick off the `fetch()` with a short client-side timeout (reuse
`FETCH_TIMEOUT_MS` from `usage.ts`), do not `await` it in the render's critical path, swallow any
rejection. The render's own segment output is entirely unaffected by whether the push succeeds.

## Local agent URL resolution

nexus-statusline has never made an outbound call to its own local nx-agent before today (its
existing HTTP calls are all to `api.anthropic.com`, made by the SEPARATE agent-side poller, not
by nexus-statusline itself). This proposal's task 3.1 must establish how nexus-statusline finds
its own local agent's base URL — the existing convention documented in `.claude/CLAUDE.md` is
`~/.config/nexus/agents.toml` for per-machine agent registration, with the agent listening on
port 7400. Task 3.1 reads that existing config file/convention rather than inventing a new one;
if the local-agent entry isn't cleanly resolvable from that file alone, fall back to
`http://localhost:7400` (nexus-statusline and nx-agent always run on the same machine for this
push — it is never a cross-machine call on the write side, only reads are cross-machine).

## Wire types: one shared source

`packages/core/src/types/session-context.ts` holds the Zod schemas for the POST body and GET
response, imported by both `apps/agent` (route validation) and, if a future consumer needs it,
any other TypeScript caller — mirroring the existing `packages/core/src/types/elevenlabs.ts` /
`integrations.ts` convention of one shared wire-contract file per capability rather than
duplicating shapes per caller.
