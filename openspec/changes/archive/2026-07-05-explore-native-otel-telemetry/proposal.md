# Change: Explore migrating CC telemetry to native OpenTelemetry (hybrid)

> **STATUS: EXPLORATION (pre-formal).** This is a `/openspec:explore` artifact, NOT an
> approved change. No delta specs (`specs/<capability>/spec.md`) exist yet on purpose —
> creating them would promote this to a formal proposal. Do not run `openspec validate`
> expecting deltas, and do not `/apply` this directory. See `exploration.md` for the
> options analysis, the gating smoke test, and open questions. A formal proposal is
> drafted only after the GATE-0 smoke test passes and the open questions below are resolved.

## Why

Today nexus ingests Claude Code telemetry through a **custom hook pipeline**: cc's
`~/.claude/scripts/hooks/telemetry.sh` emits NDJSON frames over an AF_UNIX socket
(`/tmp/nexus-agent.sock`) via the `nexus-emit` helper, which the agent's socket-server
dispatcher (`apps/agent/src/services/socket-server/dispatcher.ts`) fans out to the
SessionManager, lifecycle bus, and (for a subset) the Postgres schema. The HTTP `POST /hooks`
ingester is **retired** (code comments in `apps/agent/src/services/process-hook-event.ts:1-3`
call it "the (retired) HTTP `/hooks` endpoint"; the `hooks-endpoint` spec still documents the
old contract but the live path is the socket).

Claude Code 2.1.158 (the installed binary, verified `claude --version`) ships native
OpenTelemetry: `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus OTLP exporters emit `claude_code.*`
metrics and structured log events (tool_result, tool_decision, app.entrypoint,
skill_activated, compaction, token.usage / cost.usage, agent_id span attrs). Adopting native
OTEL for the **capture** half would let nexus delete the cc-side parsing of those signals and
**retire the transcript-tail cost hack** (`apps/agent/src/credentials/token-stream/*`, which
reads `~/.claude/projects/<cwd>/<cc_session_id>.jsonl` to reconstruct per-turn token + cost —
a workaround for the absence of a native cost feed).

But native OTEL **cannot** replace everything: cc's orchestration-lifecycle events
(`command_start`/`command_end` with `run_id`/`spec`/`wave`/`phase`, `agent_telemetry`
engineer-cost) have no native analog, and telemetry.sh carries **welded session side-effects**
(PostCompact context re-injection, Notification TTS, terminal bell) that emit to cc's own
stdout/session and have zero OTLP equivalent. So the end state is a **hybrid**: native OTEL for
the metric/event capture majority, a thin residual cc hook for orchestration events + side
effects + local-JSONL durability.

This exploration exists to decide **whether** to do this and **in what shape** — gated on
first proving native OTLP export actually works on this binary.

## What Changes (proposed, contingent on GATE-0)

- **ADD** an OpenTelemetry Collector (new systemd unit or Docker container on the homelab host,
  alongside `nexus-agent.service` and `homelab-postgres`) as the OTLP ingress for cc.
- **ADD** a secret-redaction processor in the Collector pipeline that regex-scrubs
  `tool_parameters.full_command` for `POSTGRES_URL`- / `NEXUS_ATTACH_SECRET`-shaped tokens
  before any forward.
- **ADD** an OTLP-attribute -> nexus mapping shim that lands native `claude_code.*` log/metric
  records into the existing Postgres schema (`session_events`, `session_token_turns`,
  `sessions`) so dashboards/queries keep working.
- **RETIRE** (estimated ~60% of) the cc-side telemetry.sh capture paths that native OTEL covers,
  AND the nexus transcript-tail cost reconstruction (`token-stream/*`) once native
  `cost.usage` / `token.usage` lands reliably.
- **KEEP** a thin residual cc hook for: orchestration-lifecycle events (no native analog),
  the welded side-effects (PostCompact/Notification/bell), and **local-JSONL durability** (no
  collector = no telemetry without a fallback).
- **BREAKING / cc-side**: changes to `~/.claude` are **out of scope for this nx repo** —
  this exploration only designs the nx-side ingest (Collector + shim + residual-event
  contract). The cc-side hook retirement is a separate cc-repo change that this proposal
  hands off a contract to.

## Impact

- **Affected specs (when formalized):**
  - `hooks-endpoint` (event taxonomy + persistence contract — the column targets the OTLP shim
    must hit)
  - `cc-hook-helper` (the `nexus-emit` socket contract — residual events still flow here)
  - `observability-stack` (already defines nexus's *own* OTLP export for its Rust/Node
    binaries; the Collector this proposal adds is a *new* ingress and must not collide with the
    existing `OTEL_EXPORTER_OTLP_ENDPOINT` self-export wiring)
  - likely a NEW capability `cc-otel-ingest` for the Collector + redaction + mapping shim
- **Affected code:**
  - `apps/agent/src/services/socket-server/dispatcher.ts` (residual-only after migration)
  - `apps/agent/src/credentials/token-stream/*` (candidate for deletion)
  - `apps/agent/src/credentials/model-pricing.ts` (cost hack — superseded by native cost.usage)
  - `packages/db/src/schema/{sessionEvents,sessions,sessionTokenTurns}.ts` (OTLP shim targets)
  - `infra/` + `deploy/` (new Collector unit/container + config)
- **Out of scope:** `~/.claude` and `~/dev/cc` edits (handed off as a contract, not changed here).
