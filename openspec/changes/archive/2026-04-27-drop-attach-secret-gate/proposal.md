---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-04-27T00:47:52-05:00
---
# Proposal: Drop Attach-Secret Gate

## Change ID
`drop-attach-secret-gate`

## Summary
Remove the `x-nexus-secret` header authentication entirely from the nexus-agent. Default the agent's bind to `127.0.0.1` plus the Tailscale interface (instead of `0.0.0.0` plus a soft header gate). Strip the secret from every consumer (dashboard, CLI tools, Mac notifier) and delete the corresponding env var.

## Context
- Extends: `apps/agent/src/server-auth.ts` (delete), `apps/agent/src/server-request-handler.ts` (delete auth call), `apps/agent/src/server.ts` (bind logic), `apps/nextjs/src/lib/agent-client.ts` plus 5 sibling files (strip header), `apps/nexus-status/src/index.ts` (strip header), `deploy/nexus-notifier.sh` (strip header), `deploy/README.md` (drop env-var docs), `.env.example` (drop env-var entry)
- Related: `agent-version-handshake` (archived 2026-04-27 — added the auth-exempt path set for `/version`; this proposal makes that scaffolding redundant and deletes it)
- Related capability: `agent-security` (parent spec exists with the two requirements being changed)

## Motivation
The header gate was added when nexus-agent could be exposed beyond a trusted network. In the current homelab/Tailscale-only deployment, WireGuard already authenticates every connecting device — the header gate adds friction without security. Symptoms observed 2026-04-27 on the live system:

- "Agent macbook returned HTTP 401" banner on the dashboard whenever cross-machine probes carry stale or mismatched values.
- Every consumer (dashboard, Mac notifier, status CLI) duplicates the env-var read plus header injection (8 distinct call sites).
- Test infrastructure must thread the env var through every test runner.
- Auth-exempt scaffolding introduced this morning by `agent-version-handshake` becomes pure overhead the moment the gate is dropped.

The right security model for this deployment is **network-level trust**: bind only to interfaces that are themselves authenticated (loopback plus Tailscale). The header gate was a soft check layered over an already-bound `0.0.0.0` socket — it never actually limited reach, only added a per-request token check.

## Requirements

### Requirement: Agent serves all REST endpoints without authentication

The nexus-agent SHALL serve every REST endpoint without checking any authentication header. The `requireSecret` function, the auth-exempt path set, and the `isAuthExemptPath` helper SHALL be removed from the codebase. The `x-nexus-secret` header SHALL be ignored if present (consumers that haven't yet stripped it suffer no penalty).

#### Scenario: Unauthenticated request to any endpoint succeeds

- **WHEN** a client sends `GET /health` (or any other previously-gated endpoint) with no `x-nexus-secret` header
- **THEN** the response status SHALL be 200 (or whatever the endpoint's normal success status is)
- **AND** the response body SHALL match what an authenticated request would have returned

#### Scenario: Stale x-nexus-secret header is ignored

- **WHEN** a client (e.g. a not-yet-updated Mac notifier) sends a request with a value for `x-nexus-secret`
- **THEN** the agent SHALL NOT inspect the header
- **AND** the response SHALL be identical to a request without the header

### Requirement: Agent binds to localhost and Tailscale interface by default

When `bind_address` is unset or set to `"0.0.0.0"` in `agents.toml`, the agent SHALL bind its HTTP server to two addresses simultaneously: `127.0.0.1` (loopback for local dev) and the Tailscale interface IP (discovered via `tailscale ip -4` at boot). Random LAN clients on other interfaces SHALL NOT reach the agent. An explicit `bind_address` value other than `"0.0.0.0"` SHALL be honored verbatim (escape hatch for power users).

#### Scenario: Default bind to loopback plus Tailscale

- **GIVEN** `bind_address` is not set in `agents.toml` (or set to `"0.0.0.0"`)
- **AND** the host has `tailscale0` interface with IP `100.73.182.4`
- **WHEN** the agent starts
- **THEN** `curl http://127.0.0.1:7400/health` SHALL return 200
- **AND** `curl http://100.73.182.4:7400/health` SHALL return 200
- **AND** a request from a non-loopback non-Tailscale interface (e.g. a `192.168.1.x` LAN address) SHALL fail to connect (connection refused)

#### Scenario: Tailscale unavailable

- **GIVEN** `tailscale ip -4` exits non-zero (Tailscale not installed, daemon down)
- **WHEN** the agent starts
- **THEN** the agent SHALL bind to `127.0.0.1` only
- **AND** SHALL log a warning that Tailscale interface discovery failed
- **AND** SHALL NOT exit with an error (loopback-only is a valid degraded mode)

#### Scenario: Explicit bind override is honored

- **GIVEN** `agents.toml` contains `bind_address = "127.0.0.1"`
- **WHEN** the agent starts
- **THEN** the agent SHALL bind ONLY to `127.0.0.1`
- **AND** SHALL NOT additionally bind to Tailscale (explicit overrides the default)

### Requirement: Attach-secret env var is removed from all configuration

The attach-secret env var SHALL be removed from `.env.example`, `deploy/README.md`, and any deploy script (systemd unit, launchd plist) that previously set or read it. Existing deployments may continue to set the env var harmlessly — nothing reads it after this change.

#### Scenario: .env.example contains no attach-secret reference

- **WHEN** a developer reads `.env.example`
- **THEN** there SHALL be no line referencing the attach-secret env var
- **AND** searching `.env.example` for the env-var name SHALL return no matches

#### Scenario: deploy/README.md no longer documents the env var

- **WHEN** a developer reads `deploy/README.md`
- **THEN** the env-var table SHALL NOT list the attach-secret variable
- **AND** the systemd unit examples SHALL NOT include any `Environment=` line for it

### Requirement: All dashboard consumers stop sending the header

Every place in the codebase that previously injected `x-nexus-secret` into agent requests SHALL stop sending the header. This includes `apps/nextjs/src/lib/agent-client.ts` (4 call sites), `apps/nextjs/src/app/actions/notifications.ts`, `apps/nextjs/src/app/actions/credentials.ts`, `apps/nextjs/src/app/actions/elevenlabs-credentials.ts`, `apps/nextjs/src/app/credentials/page.tsx`, `apps/nextjs/src/app/stream/route.ts`, `apps/nexus-status/src/index.ts`, and `deploy/nexus-notifier.sh`. After this change, searching for `x-nexus-secret` outside `openspec/` SHALL return zero matches in `apps/`, `deploy/`, `tests/`, and `packages/`.

#### Scenario: No remaining header injection in source

- **WHEN** the codebase is searched for `x-nexus-secret` outside `openspec/`
- **THEN** the only matches SHALL be in archived spec deltas or this spec
- **AND** there SHALL be NO matches in `apps/`, `deploy/`, `tests/`, or `packages/`

## Scope
- **IN**:
  - Delete `requireSecret`, the auth-exempt path set, and `isAuthExemptPath` from `server-auth.ts`
  - Delete the auth dispatch block in `server-request-handler.ts` (lines around 100–108)
  - Modify `server.ts` bind logic to support the multi-bind default with Tailscale discovery
  - Strip the `x-nexus-secret` header from every consumer
  - Remove the env var from `.env.example` plus `deploy/README.md`
  - Update tests that hardcode the env var (most can just drop it)
  - Spec delta: `agent-security` ADDED (new bind requirement) plus REMOVED (auth requirement)
- **OUT**:
  - Per-route auth (e.g. write-endpoint protection) — out of scope; if needed later, add a fresh requirement
  - Replacing the secret with a different auth scheme (mTLS, JWT) — explicit non-goal; trust the network
  - Changing Bun's HTTP server library or adopting a different bind mechanism beyond what `Bun.serve` already supports
  - Migrating the legacy if/else dispatcher (tracked separately as `nx-tw3vp`)

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/server-auth.ts` | Delete `requireSecret`, the auth-exempt path set, `isAuthExemptPath`. File may reduce to CORS-related helpers only or be deleted entirely |
| `apps/agent/src/server-request-handler.ts` | Delete the `if (!isAuthExemptPath(...)) requireSecret(...)` block and the imports |
| `apps/agent/src/server.ts` | New bind logic: discover Tailscale IP via `Bun.spawn(["tailscale", "ip", "-4"])`, bind to a list of addresses (loopback plus Tailscale). Honor explicit `bind_address` from `agents.toml` |
| `apps/nextjs/src/lib/agent-client.ts` | Remove 4 occurrences of the header injection |
| `apps/nextjs/src/app/actions/{notifications,credentials,elevenlabs-credentials}.ts` | Strip header from each |
| `apps/nextjs/src/app/credentials/page.tsx` | Strip header |
| `apps/nextjs/src/app/stream/route.ts` | Strip header |
| `apps/nexus-status/src/index.ts` | Strip header plus remove the `ATTACH_SECRET` const plus remove the env-var doc comment |
| `deploy/nexus-notifier.sh` | Remove header injection (2 places) plus the env-var fallback read |
| `deploy/README.md` | Drop the env-var row from the env-var table; drop the systemd `Environment=` line |
| `.env.example` | Remove the attach-secret entry |
| `~/.config/nexus/agents.toml` | Existing files unchanged (the field is now informational; `bind_address = "0.0.0.0"` triggers the new default) |
| Test files | Tests using the env var can drop it; integration tests no longer need to thread it |

## Risks
| Risk | Mitigation |
|------|-----------|
| A non-Tailscale, non-loopback client previously had access via `0.0.0.0` and breaks | The user explicitly requested this. Tailscale plus loopback IS the new contract; clients on other interfaces were never intended consumers. Document the bind change prominently in deploy/README.md |
| Tailscale daemon down at agent boot, leaving loopback-only mode | Logged as a warning, not a fatal error. Local dev still works. If a remote agent loses Tailscale, it self-isolates (correct behavior — better than binding to a bogus IP) |
| Mac notifier on an old version still sending the header | Header is ignored, no behavioral change. The cleanup task strips it from the script for tidiness, not correctness |
| Stale binary on a remote agent rejects post-merge SSH-based deploy | Unrelated to this change — deploy uses SSH (key-based), not the agent's HTTP auth. Verified working in agent-version-handshake fan-out earlier today |
| Future need for per-route auth (e.g. destructive write endpoints) | Acceptable trade-off per Phase 2 question 4 — YAGNI. Re-introduce a focused `requireAuth: true` per-route flag when concrete need arises; do not pre-build scaffolding |
