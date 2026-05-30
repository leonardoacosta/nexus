# Exploration: Native CC OpenTelemetry for nexus ingest (hybrid)

> Pre-formal think-through per `/openspec:explore`. Captures: how telemetry lands today,
> the GATE-0 smoke test that must pass before any hook retirement, the Collector + redaction
> design, the hybrid capture/residual boundary, the option set, and open questions a formal
> spec must close. **Nothing here is approved.** Verified against `~/dev/nx` reality on
> 2026-05-30 (CC binary 2.1.158).

---

## 1. How CC telemetry lands in nexus TODAY (verified)

### Live ingest path (socket, not HTTP)

```
cc ~/.claude/scripts/hooks/telemetry.sh
  → nexus-emit (apps/nexus-emit/src/index.ts)         # ~5MB bun binary, ~10ms/hook
  → AF_UNIX  /tmp/nexus-agent.sock  (NDJSON, one frame, fail-fast exit 3 if no socket)
  → agent socket-server (apps/agent/src/services/socket-server/server.ts)
  → dispatcher.ts  → SessionManager + lifecycleBus + (subset) Postgres
```

- **Socket path drift to note**: `cc-hook-helper/spec.md` says `~/.nexus/agent.sock`, but the
  shipped code (`apps/nexus-emit/src/index.ts:31`, `socket-server/types.ts:42`) defaults to
  `/tmp/nexus-agent.sock` (overridable via `NEXUS_SOCKET`). The spec is stale; code is truth.
- **HTTP `/hooks` is RETIRED.** `process-hook-event.ts:1-3` documents it as "the (retired) HTTP
  `/hooks` endpoint". The `hooks-endpoint` spec (463 lines, very detailed) still describes the
  old persistence contract, but that contract now only partially holds on the socket path
  (see next point). This is the seed's "`/hooks` deleted 2026-05-18" claim — CONFIRMED at the
  code-comment level.

### CRITICAL reality check vs. the `hooks-endpoint` spec

The detailed `hooks-endpoint` spec asserts "every recognized event type MUST produce at least
one `session_events` row." **The live socket dispatcher does NOT do this for most event types.**
Reading `dispatcher.ts`:

| SocketEvent | Dispatcher action | Writes `session_events`? |
| --- | --- | --- |
| `session_start` | SessionManager + git-origin enrich + lifecycle emit | NO (updates `sessions` only) |
| `session_stop` | SessionManager + agent_state + lifecycle | NO |
| `session_heartbeat` | SessionManager + agent_state | NO |
| `notification` | history + lifecycle (TTS signal) | NO |
| `agent_spawn` | sub-agent tree linkage (`parent_session_id`/`child_role`) | NO |
| `agent_complete` | `log.info` only | NO |
| `telemetry` | `log.debug` only | NO |
| `session_summary` | `log.info` only (no `total_cost_usd` write seen here) | NO |
| `deploy_status` | `log.info` only | NO |

So the rich event-row persistence + notification-rule engine in `hooks-endpoint/spec.md` was an
**HTTP-endpoint-era contract that the socket path did not fully re-implement**. The migration
analysis MUST treat "what is persisted today" as: `sessions` table enrichment + `sessionEvents`
sparsely + `session_token_turns` via the transcript tail watcher — NOT the full taxonomy the
spec implies. (Open question Q3.)

### The current event/record schema (the "Pino RECORD" the seed refers to)

- **Wire schema** = `SocketEvent` discriminated union in
  `apps/agent/src/types/socket-events.ts` (10 event types, `event`/`event_type` field
  normalized by `isSocketEvent`). This is the contract telemetry.sh emits against.
- **Storage schema** = Postgres via Drizzle (`packages/db/src/schema/`):
  - `session_events` — `{id, session_id FK, event_type, timestamp, metadata TEXT}` (the generic
    append target; metadata is JSON-stringified).
  - `sessions` — rich row: `model`, `total_cost_usd` (doublePrecision), `git_provider`,
    `git_owner_repo`, `parent_session_id`, `child_role`, `agent_state`, `credential_id`, etc.
  - `session_token_turns` — per-turn `{model, input/output/cache tokens, cost_usd, credential}`
    keyed `(session_id, ts)`. **This is the transcript-tail hack's output table.**
- **Logging** = Pino via `packages/core/src/logger.ts`. NOTE: nexus ALREADY has OTLP wiring for
  its OWN logs — `pino-opentelemetry-transport` activates when `OTEL_EXPORTER_OTLP_ENDPOINT` is
  set, plus a trace/span-id mixin. `observability-stack/spec.md` formalizes this (Rust
  `tracing-opentelemetry`, Node `pino-opentelemetry-transport`). **The Collector this
  exploration proposes is a SEPARATE ingress for cc's telemetry — it must not be conflated with
  nexus's self-observability export.** (Open question Q2.)

### The cost hack to retire (verified)

`apps/agent/src/credentials/token-stream/` — `transcript-locator.ts` computes
`~/.claude/projects/<encoded-cwd>/<cc_session_id>.jsonl`, `tail-watcher.ts` tails it,
`cost-calculator.ts` + `model-pricing.ts` (hardcoded per-model $/M rates, currently through
Claude 4.6) reconstruct per-turn cost into `session_token_turns`. This is the
"transcript-parse cost hack" the seed flags — a workaround for the absence of a native cost
feed (GH#52089). Native `cost.usage` / `token.usage` metrics would supersede it.

### Runtime topology (where a Collector would land)

- `nexus-agent.service` — systemd **user** unit on the homelab Linux host,
  `After=tailscaled.service` (Tailscale-IP bind).
- `homelab-postgres` — Docker `pgvector/pgvector:pg16`, host port **5436**, the sole PG on
  homelab (per `deploy/POSTGRES_SCHEMA_MAP.md`).
- No container orchestration, no k8s. `deploy/README.md`: "everything here is shell scripts and
  plists." `infra/` is Terraform for Cloudflare DNS + Tailscale + homelab-postgres only.
- **A new OTel Collector is therefore a new systemd unit OR a new Docker container on the
  homelab host**, reachable over Tailscale (cc emits from any machine in the mesh). (Q4.)

---

## 2. GATE-0: prove OTLP export works BEFORE retiring any hook (HARD GATE)

The single biggest risk. Documented CC OTEL footguns:

- `OTEL_METRICS_EXPORTER=otlp` has a **multi-month silent no-op history** (GH#50567). Setting
  the var did nothing; no error, no data.
- CC ships *events* over the OTLP **logs** protocol, not metrics (GH#15417). So
  `OTEL_LOGS_EXPORTER` is load-bearing, not just `OTEL_METRICS_EXPORTER`. A migration that only
  wires the metrics exporter silently loses every event.
- **No local-JSONL fallback** in native CC OTEL — if the Collector is down, telemetry is
  dropped on the floor. The current socket path at least fails fast and loud.

**GATE-0 procedure (must pass before formalizing, on THIS 2.1.158 binary):**

1. **Console-exporter smoke** — run cc with `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
   `OTEL_LOGS_EXPORTER=console`, `OTEL_METRICS_EXPORTER=console`,
   `OTEL_LOG_TOOL_DETAILS=1`, `OTEL_METRICS_INCLUDE_ENTRYPOINT=1`. Confirm that
   `claude_code.tool_result`, `tool_decision`, `token.usage`, `cost.usage`,
   `skill_activated`, `compaction`, and `app.entrypoint` actually print to console. Record
   the exact record shapes (this becomes the mapping-shim input contract).
2. **Collector-received count** — stand up a throwaway otelcol with a `logging`/`debug`
   exporter, point cc at it via `OTLP`, and assert the Collector's received-record counter is
   non-zero for both the logs and metrics pipelines. This catches the #50567 silent no-op.
3. **Only after 1+2 pass** does any cc-side hook retirement get scheduled. If GATE-0 fails on
   2.1.158, the whole migration parks until a CC version fixes export — the hybrid keeps the
   socket path as primary.

GATE-0 evidence (console stdout snippet + Collector counter) MUST be pasted into the formal
proposal's design.md before it leaves draft. (Per `rules/CORE.md` Verification iron law — no
"should work" on the load-bearing claim.)

---

## 3. Target shape: Collector + redaction + mapping shim

```
cc 2.1.158  (CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_LOGS_EXPORTER=otlp,
             OTEL_METRICS_EXPORTER=otlp, OTEL_LOG_TOOL_DETAILS=1,
             OTEL_METRICS_INCLUDE_ENTRYPOINT=1)
   │  OTLP/gRPC or /HTTP over Tailscale
   ▼
OpenTelemetry Collector  (NEW — homelab systemd unit or Docker container)
   ├─ receiver: otlp (logs + metrics pipelines BOTH wired — #15417)
   ├─ processor: REDACTION — regex-scrub tool_parameters.full_command
   │             for POSTGRES_URL / NEXUS_ATTACH_SECRET-shaped tokens
   │             (transform/redaction processor or attributes processor)
   └─ exporter: → nexus mapping shim
   ▼
OTLP-attribute → nexus Pino-RECORD / Drizzle column mapping shim
   ├─ claude_code.tool_result/tool_decision → session_events row
   ├─ token.usage / cost.usage             → session_token_turns (RETIRES transcript tail)
   ├─ app.entrypoint                        → sessions.session_type / metadata
   ├─ agent_id / parent_agent_id span attrs → sessions.parent_session_id / child_role
   └─ skill_activated / compaction          → session_events row
   ▼
homelab-postgres (5436)  — existing schema, unchanged targets
```

- **Redaction**: the regex set must cover the same shapes the cc-side telemetry.sh redactor
  handles. `full_command` (from `OTEL_LOG_TOOL_DETAILS=1`) is the high-risk field — it can
  contain `POSTGRES_URL=...`, `NEXUS_ATTACH_SECRET=...`, bearer tokens. Redaction lives in the
  Collector (one trusted hop) not the shim, so secrets never touch nexus storage.
- **Mapping shim**: native OTLP attribute names ≠ nexus column names. The shim translates
  `claude_code.*` semantic conventions into the existing `session_events` / `sessions` /
  `session_token_turns` schema so existing dashboards + queries keep working with zero
  migration. Lives where? — Collector custom exporter vs. a small nexus-agent OTLP receiver
  route. (Q1.)

---

## 4. Hybrid boundary — what native OTEL CAN vs CANNOT replace

### Native OTEL CAN capture (the ~60% retirement target)

| Signal | Native source | Replaces in nexus |
| --- | --- | --- |
| Tool result / decision | `claude_code.tool_result`, `tool_decision` | socket `telemetry` / tool events |
| Tool params (full_command, file_path, skill_name, subagent_type) | `tool_parameters` w/ `OTEL_LOG_TOOL_DETAILS=1` | redacted tool detail |
| Entrypoint | `app.entrypoint` w/ `OTEL_METRICS_INCLUDE_ENTRYPOINT=1` | `sessions.session_type` |
| Sub-agent tree | `agent_id` / `parent_agent_id` span attrs, `agent.name` metric attr | `parent_session_id`/`child_role` |
| Skill activation | `claude_code.skill_activated` | (new — not captured today) |
| Compaction | `claude_code.compaction` | PostCompact event |
| Token + cost | native `token.usage` / `cost.usage` | **RETIRES transcript-tail hack** (GH#52089) |
| Prompt correlation | `prompt.id` | join key |

### Native OTEL CANNOT replace (residual cc hook stays)

1. **Orchestration-lifecycle events** — `command_start`/`command_end`/metadata carrying
   `run_id` / `spec` / `wave` / `phase`, and `agent_telemetry` engineer-cost roll-ups. No native
   analog. Per-subagent token attribution was closed **NOT_PLANNED** upstream (GH#22625), so
   native will never emit it — the residual hook owns this permanently.
2. **Daily-stats git/openspec state** — no native analog.
3. **Welded side-effects in telemetry.sh** — PostCompact context re-injection, Notification
   TTS, terminal bell. These write to cc's own session stdout / fire local audio. **Zero OTLP
   equivalent** — OTLP is one-way egress, it cannot mutate the emitting session. These MUST
   stay in a cc-side hook.
4. **Local-JSONL durability** — native OTEL drops telemetry if the Collector is down. The
   residual hook should keep a local-JSONL fallback so a Collector outage is not a data hole.

**End state**: native OTEL = capture majority; residual thin cc hook = orchestration events +
side-effects + JSONL durability. The socket path (`nexus-emit`) stays alive for the residual
events.

---

## 5. Option set (recommendation marked)

### Option A — Full cutover to native OTEL, delete the hook pipeline
- Retire socket path entirely; everything via Collector.
- **Rejected.** Loses orchestration events (no native analog), kills the welded side-effects,
  no JSONL durability. The seed's own analysis rules this out.

### Option B — Hybrid: native capture + thin residual hook  ★ RECOMMENDED
- Native OTEL for the metric/event capture majority; residual cc hook for orchestration +
  side-effects + JSONL durability. Collector with redaction + mapping shim on homelab.
- **Why recommended**: it is the only option that captures the native-token/cost win (retires
  the transcript hack) WITHOUT losing orchestration data or the session-mutating side effects.
  It also degrades gracefully — if GATE-0 partially passes (e.g. logs export works, metrics
  silent-no-op per #50567), the residual hook can keep owning the silent signal until CC fixes it.

### Option C — Status quo, do nothing
- Keep the transcript-tail cost hack + full socket pipeline.
- **Fallback if GATE-0 fails on 2.1.158.** Not a goal, but the safe parking spot.

**Recommendation: Option B, strictly gated on GATE-0.** Phase it: (1) GATE-0 smoke; (2) stand
up Collector + redaction in *shadow* (ingest native OTEL alongside the existing socket path,
compare counts); (3) build the mapping shim + verify column parity; (4) ONLY THEN retire the
covered cc-side capture paths + the transcript hack; (5) leave the residual hook permanently.

---

## 6. Open questions a formal spec MUST resolve

1. **Mapping-shim home** — is the OTLP→nexus column translation a custom Collector exporter, or
   a new OTLP-receiver route inside `nexus-agent`? The latter reuses the existing DB layer +
   Drizzle schema and the Pino/OTLP wiring already in `packages/core/src/logger.ts`, but adds an
   HTTP/gRPC ingress surface to the agent (auth, the `x-nexus-secret` story from
   `observability-stack`). The former keeps the agent unchanged but duplicates schema knowledge
   in Collector config. **Pick one before formalizing.**
2. **Collector vs. nexus self-observability collision** — `observability-stack/spec.md` already
   uses `OTEL_EXPORTER_OTLP_ENDPOINT` for nexus's OWN logs/traces. Does cc point at the SAME
   Collector (multiplexed, `service.name` discriminates) or a dedicated one? Shared = one unit
   to run but redaction must not scrub nexus's own logs; dedicated = clean isolation but two
   collectors on homelab.
3. **`session_events` persistence contract reconciliation** — the live socket dispatcher does
   NOT persist most event types (Section 1), yet `hooks-endpoint/spec.md` says it must. Does the
   OTEL migration (a) restore full persistence via the shim, (b) formally narrow the
   `hooks-endpoint` spec to match reality, or (c) both? This is a pre-existing spec/code drift
   the migration is forced to confront — it can't land a mapping shim without deciding the
   target row contract.

### Secondary unknowns (resolve in design.md, not gating)
- Collector deploy form: systemd unit (matches `nexus-agent.service`) vs Docker (matches
  `homelab-postgres`). Tailscale reachability + restart-on-boot ordering either way.
- Redaction regex completeness — must be A/B'd against the cc-side telemetry.sh redactor so the
  Collector is not *less* safe than today's hook.
- `model-pricing.ts` deletion timing — only after native `cost.usage` is confirmed populated
  and column-mapped (else cost goes dark).
- Stale `cc-hook-helper` socket-path spec (`~/.nexus/agent.sock` vs `/tmp/nexus-agent.sock`) —
  fix opportunistically.

---

## 7. Provenance

Seed findings from a prior cc-session investigation; the load-bearing claims were re-verified
against `~/dev/nx` on 2026-05-30:

| Seed claim | nx-verification result |
| --- | --- |
| `/hooks` deleted 2026-05-18 | CONFIRMED at code-comment level ("retired", `process-hook-event.ts`); HTTP route gone, socket is live path |
| nexus-emit AF_UNIX bridge | CONFIRMED (`apps/nexus-emit/src/index.ts`), socket default `/tmp/nexus-agent.sock` (NOT spec's `~/.nexus/agent.sock`) |
| Pino RECORD schema | CONFIRMED — Pino logger w/ OTLP transport already present; storage = Drizzle `session_events`/`sessions`/`session_token_turns` |
| transcript-parse cost hack | CONFIRMED (`credentials/token-stream/*` + `model-pricing.ts`) |
| CC 2.1.158 binary | CONFIRMED (`claude --version`) |
| No native OTEL ingest in nx today | CONFIRMED — only OTLP ref is nexus's OWN self-export in `logger.ts` |
| Spec says every event persists a row | CONTRADICTED by live socket dispatcher (most events log-only) — new finding, Q3 |
