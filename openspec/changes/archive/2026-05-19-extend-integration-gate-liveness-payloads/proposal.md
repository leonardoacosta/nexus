# Proposal: Extend integration gate with liveness + live-session + payload decoders

## Change ID

extend-integration-gate-liveness-payloads

## Phase

Quality hardening — close three coverage gaps in the existing pre-push integration gate
(`add-fullstack-integration-test-gate`, archived 2026-05-19).

## Summary

The full-stack integration gate shipped 2026-05-19 covers bundle integrity, /health and /sessions
contract shape, socket-spine round-trip, view-render-all-pages, and one client transport probe.
Three real gaps remain — silent regressions still pass:

1. **Liveness vs shape** — `/health` returns CPU/RAM but says nothing about the agent's own
   subsystems. A dead DB connection, hung watcher, or non-listening socket all return 200 with
   a well-shaped HealthMetrics payload. Today's test passes.
2. **Live session check** — the `/sessions` contract test passes on `[]`. A regression in the
   discovery scanner, watcher heartbeat, or session-store query produces an empty response and
   the gate is happy.
3. **Per-endpoint client payload decode** — `IntegrationGateUITests` fetches sessions via the
   stub-agent. Specs, projects (with the new `id`/`hidden` fields shipped this week),
   credentials, notifications, and failures decoders have no end-to-end coverage. Adding a
   field that breaks Codable on the Swift side ships clean today.

This change extends the existing gate with: a liveness extension to `/health` (3 new boolean/
numeric fields), a socket-spine session-injection roundtrip that proves /sessions actually
serves live data, and a Swift `PayloadDecodeTests.swift` exercising all five untested model
decoders.

## Context

- depends on: (none — `add-fullstack-integration-test-gate` already archived)
- touches: `apps/agent/src/server-health-handler.ts`, `apps/agent/src/services/process-watcher.ts`, `apps/agent/src/services/socket-server.ts`, `apps/agent/src/testing/homelab-transport.test.ts`, `apps/swift/NexusSharedTests/PayloadDecodeTests.swift`, `apps/swift/project.yml`, `deploy/hooks.d/pre-push/01-deploy`, `packages/core/src/types/health.ts`

## Motivation

The cost of the dashboard-empty incident was not missing tests — it was tests that pass on
broken state. The existing gate prevents the five-layer fault from recurring identically. But
three failure modes from that incident class are still silent:

- **DB connection drop** (post-incident, the agent kept answering `/health` 200 even when the
  Drizzle pool was dead). Liveness fields catch this.
- **Watcher heartbeat hung** (nx-z66n8 root cause). `last_watcher_tick_ms` makes a stale
  watcher visible.
- **Empty discovery scan** (folder-based-project-autodiscovery shipped a 60s scanner — if it
  panics on startup, `/sessions` may still be empty but `/health` is fine). Socket-spine
  injection proves the read path works.
- **Swift decode breakage** (adding `hidden`/`id` to `/projects` could have crashed the
  ProjectsView decoder; only luck made the optional decode survive). Payload tests pin the
  contract.

## Locked Decisions

- **Liveness API**: extend `/health` with `db_ok: boolean`, `last_watcher_tick_ms: number`,
  `socket_server_listening: boolean`. One endpoint, one fetch. Rejected: new `/livez` endpoint
  (added a second probe call to every dashboard refresh for no separation benefit).
- **Live-session fixture**: socket-spine inject. Emit `session_start` NDJSON via the agent's
  UNIX socket, poll `GET /sessions`, assert the row materialised, emit `session_end` cleanup.
  Reuses the spine roundtrip already shipped. Runs in Tier A without PG. Rejected: PG seed
  (forces heavy gate), stub-agent fixture (gains no live coverage).
- **Payload coverage**: all five untested decoders (Projects, Credentials, Specs, Notifications,
  Failures). Maximum coverage; lower-risk decoders are cheap to add and pin the contract.
- **Tier placement**: liveness + socket-inject in Tier A (`bun test` with
  `NEXUS_HEAVY_TESTS=1`), payload tests in the existing Tier A `xcodebuild test` invocation
  for `NexusSharedTests`. No new Tier B XCUITest work — keeps macOS gate time flat.

## Out of Scope

- New endpoints, new dashboards, new error UX for liveness failure. The liveness signal is
  consumed only by tests in this change; surfacing it to users is a separate proposal.
- Refactoring the watcher tick exposure into a generic observer interface. Single helper now;
  generalise later if a second consumer appears.
- Failure injection (chaos testing the agent's own subsystems). Out of scope; this gate is
  about catching real production regressions, not synthetic ones.
