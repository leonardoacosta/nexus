---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-04-26T23:28:15-05:00
---
# Proposal: Agent Version Handshake

## Change ID
`agent-version-handshake`

## Summary
Add `GET /version` to the nexus-agent that returns `{ buildSha, builtAt, capabilities[] }`, with capabilities auto-introspected from the live route table. Replace the dashboard's misleading "Agent unreachable" banner with a diagnostic that distinguishes a stale binary (route returns 404, agent self-reports missing capability) from real network failure.

## Context
- Extends: `apps/agent/src/routes.ts` (route registration), `apps/agent/src/index.ts` (boot), `apps/agent/package.json` (build script), `apps/nextjs/src/app/actions/notifications.ts` and `apps/nextjs/src/app/actions/credentials.ts` (consumers)
- Related: dashboard-data-paths spec (existing capability covering NXT→agent data flow)
- Trigger: 2026-04-26 homelab incident — `add-notification-control-dashboard` (commit `cbc11c2`) shipped `/notifications/settings` routes in source, but the running binary at `~/.local/bin/nexus-agent` was built without them. `GET /notifications/settings` returned 404; the dashboard collapsed that to `agentReachable=false` and showed "Agent unreachable — controls disabled" even though the agent process was healthy and serving every other route.

## Motivation
Today the dashboard cannot distinguish:
- agent down (network/timeout)
- agent unregistered (no row in `agents.toml`)
- route missing (stale binary predates a recent `/apply`)
- route 5xx (handler exception)

All four collapse into a single `null` return from `fetchNotificationSettings()` and the same warning banner. This actively masks the most common failure on a multi-machine deployment fleet — binary lag — and gives the user no actionable diagnostic. A deliberate capability handshake at the boundary lets the dashboard say "agent at homelab is build `4f2a` from 2026-04-26 and is missing `GET /notifications/settings` — rebuild needed" instead of a misleading reachability lie.

## Requirements

### Requirement: Version endpoint exposes build identity and capabilities

The agent SHALL serve `GET /version` returning a JSON object `{ buildSha: string, builtAt: string, capabilities: string[] }`. `buildSha` is the short Git SHA the binary was compiled from, `builtAt` is the build timestamp in ISO-8601 UTC, and `capabilities` is an alphabetically-sorted array of `"<METHOD> <path>"` strings derived from the live `Route[]` table at boot.

#### Scenario: Fresh binary reports current build

- **WHEN** an operator runs `bun run build` against commit `abc1234` at `2026-05-01T10:00:00Z`
- **AND** the resulting binary is started
- **AND** a client requests `GET /version`
- **THEN** the response status SHALL be 200
- **AND** the body SHALL contain `buildSha: "abc1234"` and `builtAt: "2026-05-01T10:00:00Z"`
- **AND** `capabilities` SHALL include every `"<METHOD> <path>"` pair returned by `buildRoutes()`

#### Scenario: Capabilities reflect live route table

- **WHEN** a developer adds a new route `GET /foo/bar` to a route builder
- **AND** rebuilds and starts the agent
- **AND** a client requests `GET /version`
- **THEN** `capabilities` SHALL contain `"GET /foo/bar"` without any source change to the version endpoint itself

#### Scenario: Stale binary reports its actual capability set

- **WHEN** a binary built before `/notifications/settings` was added is running
- **AND** a client requests `GET /version`
- **THEN** `capabilities` SHALL NOT contain `"GET /notifications/settings"`
- **AND** the binary's reported `buildSha` SHALL match the commit it was compiled from, not the current source tree

### Requirement: Build embeds Git SHA and timestamp at compile time

The build pipeline (`apps/agent/package.json` `build` script and `deploy/hooks.d/post-merge/02-deploy`) SHALL embed the current Git SHA and build timestamp into the binary so that the `/version` endpoint can return them at runtime without filesystem lookups. The build SHALL fail fast if the values cannot be determined (no fallback to "unknown").

#### Scenario: Build script populates version constants

- **WHEN** `bun run build` is invoked from `apps/agent/`
- **THEN** the build SHALL produce `apps/agent/src/version.gen.ts` containing `BUILD_SHA` and `BUILT_AT` constants from `git rev-parse --short HEAD` and the current ISO timestamp
- **AND** the resulting binary SHALL return those values from `/version`

#### Scenario: Build fails when Git is unavailable

- **WHEN** `bun run build` is invoked outside a Git working tree
- **THEN** the build SHALL exit non-zero with an error message naming the missing requirement
- **AND** no binary SHALL be produced

### Requirement: Version endpoint requires no authentication

`GET /version` SHALL be served without the `x-nexus-secret` requirement that gates other agent routes. The response is build metadata only — no session data, no credentials, no DB rows — and is needed by health checks and the dashboard before any authenticated call can be qualified.

#### Scenario: Unauthenticated client receives version

- **WHEN** a client requests `GET /version` without `x-nexus-secret`
- **THEN** the response status SHALL be 200
- **AND** the body SHALL contain the version payload

## Scope
- **IN**:
  - New `GET /version` route on the agent
  - `version.gen.ts` build artifact + build-script wiring
  - Auto-introspected `capabilities[]` derived from `buildRoutes()`
  - Dashboard probe + diagnostic banner replacing "Agent unreachable" on `/notifications` and `/credentials`
  - Reachability classifier in shared dashboard helper (`agent-reachability.ts`)
- **OUT**:
  - Schema-version field (deferred — not requested in this round)
  - Sentry breadcrumb on mismatch (deferred — banner-only is enough for now)
  - Full-page block on missing capability (rejected — page should still render)
  - Auto-rebuild trigger on detected drift (out of scope; remains a manual `deploy/hooks.d/post-merge/02-deploy --force`)
  - `/version` for the dashboard (this proposal is agent-only)

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/routes/` | New `version.ts` builder, registered in `routes.ts` after `buildMiscRoutes` |
| `apps/agent/src/version.gen.ts` | New generated file (`.gitignore`'d), populated by build script |
| `apps/agent/package.json` | `build` script wraps `bun build` with a pre-step that writes `version.gen.ts` |
| `deploy/hooks.d/post-merge/02-deploy` | Unchanged — already invokes `bun run build` |
| `apps/nextjs/src/lib/agent-reachability.ts` | New helper: probes `/version`, returns discriminated union `{ ok, build, capabilities } \| { reason: "no-agent" \| "timeout" \| "stale-binary" \| "http-error", detail }` |
| `apps/nextjs/src/app/actions/notifications.ts` | `fetchNotificationsPageData` consults the new helper to classify reachability before falling back |
| `apps/nextjs/src/app/notifications/NotificationsClient.tsx` | Banner copy switches on reachability reason |
| `apps/nextjs/src/app/credentials/page.tsx` | Same banner upgrade for parity |

## Risks
| Risk | Mitigation |
|------|-----------|
| Capability strings (`"GET /notifications/settings"`) become a public API the dashboard depends on, drifting silently if route paths change | Treat them as a contract: dashboard probes are scoped to a small known list documented in `lib/agent-reachability.ts`. Adding new capabilities is additive; renaming a path is a breaking change that requires updating both sides — same coupling that already exists informally |
| Auto-introspection over the route table may include internal/streaming routes the dashboard doesn't care about | Acceptable: the response is informational. Dashboard only checks for capabilities it cares about; extras are ignored |
| Build pre-step adds Git dependency to the build pipeline | Already true (the deploy hook is Git-driven). Hard-fail on missing Git is preferable to a silent "unknown" SHA that defeats the entire diagnostic |
| `version.gen.ts` if accidentally committed creates a noise diff per build | Add to `.gitignore` and assert in CI |
