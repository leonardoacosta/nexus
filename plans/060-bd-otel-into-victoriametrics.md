# Plan 060: Pipe bd's OTel metrics into the existing VictoriaMetrics/Grafana stack

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done. Deploy-config changes only — no agent source
> code.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- deploy/ .env.example`
> On structural deploy changes, re-survey before editing.

## Status

- **Priority**: P3 (cheap, high-signal, but observability not correctness)
- **Effort**: S
- **Risk**: LOW (opt-in env var; bd metrics are disabled by default and fail-soft)
- **Depends on**: none
- **Category**: dx / observability
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters

bd 1.1.0 exports OTLP-HTTP metrics behind a single env var —
`BD_OTEL_METRICS_URL` — including:

- `bd_issue_count{status}` — the same counts nexus dashboards derive, now
  as a time series;
- `bd_db_lock_wait_ms` / `bd_db_retry_count_total` — **directly quantifies
  the concurrent-session Dolt contention** this repo demonstrably has
  (plan 059's collision class), turning "two sessions collided" from git
  archaeology into a graph;
- dolt push/pull spans (stdout mode) for Tailscale sync latency.

The recommended receiving stack in bd's own docs is VictoriaMetrics
(`:8428/opentelemetry/api/v1/push`) + Grafana — which this repo ALREADY
runs (the agent reads session costs from VictoriaMetrics via `VmReadClient`;
Grafana/Loki landed via `wire-nexus-agent-grafana-otel`). Enabling is
plumbing, not building.

bd runs in interactive shells and CC sessions — not under the systemd
units — so the env var must land where `bd` actually executes: shell
profiles and the deploy env files that seed them.

## Current state (survey these — the plan is discovery-shaped)

- `deploy/secrets.env.example` — the canonical operator env template (the
  anti-drift rule in `.claude/CLAUDE.md` binds homelab `~/.env` to it).
- `deploy/nexus-agent.service`, `deploy/launchagents/`,
  `deploy/dev.leonardoacosta.nexus.deploy.plist` — service env plumbing.
- The VictoriaMetrics endpoint: find the live address —
  `grep -rn "8428\|victoria\|VM_URL" deploy/ apps/agent/src .env.example`
  (Wave 5 recorded a `VM_URL` env var documented in `.env.example`). The
  push endpoint for OTLP is `<vm-base>/opentelemetry/api/v1/push` per bd
  docs — confirm the path against the VM version's docs if reachable, else
  trust bd's documented default.

## Steps

### Step 1 — Env plumbing

- Add to `deploy/secrets.env.example` (matching its comment style):

```
# bd (beads) OTel metrics -> VictoriaMetrics (plan 060). Optional; unset = off.
# Same VM instance the agent's VmReadClient reads from.
BD_OTEL_METRICS_URL=http://<vm-host>:8428/opentelemetry/api/v1/push
```

  with `<vm-host>` filled from the discovered live value (Tailscale address
  or localhost per machine role — mirror how VM_URL is documented).
- Add the same line, commented, to `.env.example` if that file is the
  operator-facing doc for shell env (check which file the repo treats as
  operator-facing — Wave 4/5 plans 022/030/036 established the split;
  follow it).
- Do NOT add it to the systemd/launchd unit files unless the survey shows
  bd is invoked BY the agent daemon (it is — `cached-bead-source` cold
  starts and plan 057's hygiene collector spawn bd from the agent!). So DO
  add `BD_OTEL_METRICS_URL` pass-through to the agent service env
  (`nexus-agent.service` Environment= or EnvironmentFile= — read how the
  unit currently sources env and match).

### Step 2 — Shell-profile documentation

The bulk of bd invocations are interactive/CC sessions. Add a short section
to `deploy/README.md` (or the runbook the survey shows is operator-facing):
export `BD_OTEL_METRICS_URL` in the shell profile on each machine, with the
per-machine value, plus optional `BD_OTEL_STDOUT=true` for span debugging.

### Step 3 — Grafana dashboard stub

Check `deploy/assets/` (or wherever `wire-nexus-agent-grafana-otel` put
Grafana provisioning — survey `deploy/` and `infra/` for dashboard JSON).
If a provisioning path exists, add `bd-beads.json` with three panels:
`bd_issue_count` by status, `bd_db_lock_wait_ms` (p95), and
`bd_db_retry_count_total` rate — follow an existing dashboard JSON as the
exemplar for datasource UID conventions. If NO provisioning path exists
(dashboards are click-ops), emit the three PromQL/MetricsQL queries in the
README section instead and skip the JSON.

### Step 4 — Verify (as far as the environment allows)

- Files lint: `python3 -m json.tool` on any dashboard JSON; systemd unit
  parses (`systemd-analyze verify deploy/nexus-agent.service` if available,
  else visual).
- OPERATOR verification handoff (emit in report): set the var, run any `bd
  list`, then query
  `curl '<vm-base>/api/v1/query?query=bd_issue_count'` — series present.

## Done criteria (machine-checkable)

- `grep -c "BD_OTEL_METRICS_URL" deploy/secrets.env.example` → 1.
- Agent service env passes the var through
  (`grep -c "BD_OTEL" deploy/nexus-agent.service` → ≥ 1, or the
  EnvironmentFile chain demonstrably covers it — document which).
- Dashboard JSON valid, or queries documented (per Step 3 branch).
- `git diff --stat` touches only deploy/ + env example files (+ README).

## Out of scope — do not touch

- Agent source code, VmReadClient.
- Traces backend (bd exports traces only to stdout; the recommended stack
  has no trace receiver — do not build one).
- `bd compact` / `bd_ai_*` metrics (unused feature; panels would be empty).

## STOP conditions

- If no VictoriaMetrics endpoint is discoverable in the repo (VM_URL absent
  everywhere), STOP — the receiving stack's address is operator knowledge;
  ask rather than invent.
- If the agent's env is sourced ONLY from a secrets file that must not gain
  non-secret entries per repo convention (check POSTGRES_SCHEMA_MAP /
  anti-drift notes), put the var in the correct layer and document the
  deviation.

## Maintenance notes

- After plan 057 lands, the agent's own bd spawns (hygiene collector, cold
  starts) emit metrics through this same var — spawn-frequency regressions
  become visible in Grafana (`bd_storage_*` op counts), which is the
  crash-loop early-warning this repo never had.
- On bd upgrades, re-check the metric name list (bd docs
  reference/observability) — panels reference names by string.
