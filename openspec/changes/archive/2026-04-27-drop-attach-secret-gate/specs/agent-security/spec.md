# agent-security Specification

## ADDED Requirements

### Requirement: Agent binds to loopback and Tailscale interface by default

When `bind_address` is unset or set to `"0.0.0.0"` in `agents.toml`, the agent SHALL bind its HTTP server to two addresses simultaneously: `127.0.0.1` (loopback) and the Tailscale interface IP discovered via `tailscale ip -4` at boot. Random LAN clients on other interfaces SHALL NOT reach the agent. An explicit `bind_address` value other than `"0.0.0.0"` SHALL be honored verbatim and SHALL NOT trigger the multi-bind default.

#### Scenario: Default bind to loopback plus Tailscale

- **GIVEN** `bind_address` is not set in `agents.toml` (or set to `"0.0.0.0"`)
- **AND** the host has a `tailscale0` interface with IP `100.73.182.4`
- **WHEN** the agent starts
- **THEN** `curl http://127.0.0.1:7400/health` SHALL return 200
- **AND** `curl http://100.73.182.4:7400/health` SHALL return 200
- **AND** a request from a non-loopback non-Tailscale interface (e.g. a `192.168.1.x` LAN address) SHALL fail to connect

#### Scenario: Tailscale unavailable degrades to loopback-only

- **GIVEN** `tailscale ip -4` exits non-zero (Tailscale not installed, daemon down, or no network)
- **WHEN** the agent starts
- **THEN** the agent SHALL bind to `127.0.0.1` only
- **AND** SHALL log a warning naming the missed Tailscale binding
- **AND** SHALL NOT exit with an error (loopback-only is a valid degraded mode)

#### Scenario: Explicit bind override is honored without the Tailscale fallback

- **GIVEN** `agents.toml` contains `bind_address = "127.0.0.1"`
- **WHEN** the agent starts
- **THEN** the agent SHALL bind ONLY to `127.0.0.1`
- **AND** SHALL NOT additionally bind to Tailscale
- **AND** SHALL NOT shell out to `tailscale ip -4` at all

## REMOVED Requirements

### Requirement: Shared Secret Authentication for Run Endpoint

**Reason:** Network-level trust supersedes the header gate. With the agent now binding only to loopback plus the Tailscale interface (per the new bind requirement above), every connection is already authenticated at the WireGuard layer. The `x-nexus-secret` header was a soft check layered over an already-bound `0.0.0.0` socket — it never limited reach, only added per-request token bookkeeping that produced misleading "Agent unreachable" / "HTTP 401" banners on the dashboard whenever values mismatched. Eight call sites in dashboard, CLI, and Mac notifier code all duplicated the env-var read plus header injection. Future destructive endpoints can re-introduce a focused per-route auth gate when concrete need arises (YAGNI).

**Migration:** Existing deployments may continue to set the `NEXUS_ATTACH_SECRET` env var harmlessly — nothing reads it after this change. Stale clients that send `x-nexus-secret` on every request suffer no penalty (the header is ignored). Hard cutover is acceptable because the entire fleet is single-tenant and deploys atomically via the post-merge SSH fan-out.
