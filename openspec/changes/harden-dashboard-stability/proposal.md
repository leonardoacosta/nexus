# Proposal: Harden Dashboard Stability

## Change ID
`harden-dashboard-stability`

## Summary
Add the missing `instrumentation.ts` Next.js hook so Sentry v8 initializes server-side, and add a restart-storm guard (`StartLimitBurst`) to the systemd service to prevent runaway crash-loop cycles.

## Context
- Extends: `apps/nextjs/sentry.server.config.ts`, `apps/nextjs/sentry.client.config.ts`
- Extends: `deploy/nexus-dashboard.service`
- Related: archived `2026-04-05-add-observability-stack` (Sentry init design), active `improve-platform-observability` (27/28 — `beforeSend` scrubbing, does NOT include `instrumentation.ts`)

## Motivation
Two issues surfaced from a production incident where `nexus.leonardoacosta.dev` served 500 errors:

1. **Sentry v8 not initializing**: `@sentry/nextjs@^8` dropped support for auto-loading `sentry.server.config.ts` at request time. The SDK now requires a Next.js `instrumentation.ts` file that exports a `register()` function calling `Sentry.init`. Without it, unhandled server-side exceptions are swallowed silently and never reach Sentry — the very errors we need most visibility into.

2. **Runaway crash loop**: The `nexus-dashboard.service` reached restart counter 65 in a single session (5–9 second lifespans, exit codes 143/137). `Restart=always` with no `StartLimitBurst` lets the service retry indefinitely, saturating systemd's restart queue and preventing operators from noticing the loop. Adding `StartLimitBurst=5 / StartLimitIntervalSec=30` pauses restarts after 5 failures in 30s and surfaces a `systemctl --user status` failure state.

## Requirements

### Req-1: Next.js instrumentation hook for Sentry v8
`apps/nextjs/instrumentation.ts` MUST exist at the app root (alongside `next.config.ts`) and export:
- `register()` — async function that conditionally imports `./sentry.server.config` when `process.env.NEXT_RUNTIME === 'nodejs'`
- `onRequestError` — re-exported from `@sentry/nextjs` as `captureRequestError`, giving Next.js a hook to forward App Router errors to Sentry automatically

The existing `sentry.server.config.ts` and `sentry.client.config.ts` files are NOT modified — `instrumentation.ts` composes them.

### Req-2: Systemd restart-storm guard
`deploy/nexus-dashboard.service` MUST include:
```
StartLimitBurst=5
StartLimitIntervalSec=30
```
under the `[Unit]` stanza so that five rapid restarts within a 30-second window halt automatic recovery and surface a visible failed state. `Restart=always` and `RestartSec=5` are retained.

## Scope
- **IN**: `apps/nextjs/instrumentation.ts` (new file), `deploy/nexus-dashboard.service` (two new lines)
- **OUT**: Changes to `sentry.server.config.ts`, `sentry.client.config.ts`, `next.config.ts`; Sentry DSN provisioning; Traefik config; agent-side observability (covered by `improve-platform-observability`)

## Impact
| Area | Change |
|------|--------|
| `apps/nextjs/` | New `instrumentation.ts` (3 lines) |
| `deploy/nexus-dashboard.service` | Two new `[Unit]` directives |
| TypeScript diagnostics | Resolves LSP error 1128 on `instrumentation.ts` |
| Sentry | Server errors now captured and forwarded |
| Systemd | Crash loops self-limit after 5 failures / 30s |

## Risks
| Risk | Mitigation |
|------|-----------|
| `register()` called twice (dev hot-reload) | Sentry SDK is idempotent on multiple `init()` calls |
| `StartLimitBurst` hides real availability issues | Operators notified via `systemctl --user status`; can `systemctl --user reset-failed nexus-dashboard && systemctl --user start nexus-dashboard` to recover |
