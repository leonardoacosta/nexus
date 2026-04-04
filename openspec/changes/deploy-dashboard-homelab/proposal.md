# Proposal: Deploy Dashboard to Homelab via Traefik

## Change ID
`deploy-dashboard-homelab`

## Summary
Add deployment artifacts so the Nexus Next.js dashboard runs as a systemd user service on the homelab and is accessible at `nexus.leonardoacosta.dev` via Traefik reverse proxy — reachable only over Tailscale.

## Context
- Extends: `deploy/install.sh`, `deploy/nexus-agent.service` (pattern)
- Related: none archived — first deployment spec for the dashboard

## Motivation
The dashboard has no homelab deployment path. The agent daemon already runs as a systemd user service (`nexus-agent.service`) with a working install script. The dashboard needs the same treatment: a systemd unit for `next start`, a Traefik dynamic config file for routing `nexus.leonardoacosta.dev → localhost:3100`, and an updated install script. Traefik and Tailscale are assumed already running on homelab.

## Requirements

### Req-1: nexus-dashboard systemd service
A `deploy/nexus-dashboard.service` unit file runs `next start --port 3100` from the repo's `apps/nextjs` working directory. It mirrors the hardening and restart policy of `nexus-agent.service`. The `NEXUS_AGENTS` environment variable is sourced from `~/.env` so the dashboard knows which agents to poll.

### Req-2: Traefik dynamic config for nexus.leonardoacosta.dev
A `deploy/traefik/nexus-dashboard.yml` Traefik file-provider config declares:
- A router matching `Host("nexus.leonardoacosta.dev")` with TLS enabled
- A service forwarding to `http://localhost:3100`
- Let's Encrypt TLS via Cloudflare DNS-01 challenge (cert resolver name: `cloudflare`)

The file is deployed to the homelab's Traefik watch directory (e.g. `/etc/traefik/dynamic/`).

### Req-3: install.sh updated for dashboard
`deploy/install.sh` gains a `--dashboard` flag (or auto-installs alongside agent) that:
1. Copies `nexus-dashboard.service` to `~/.config/systemd/user/`
2. Copies `deploy/traefik/nexus-dashboard.yml` to the Traefik dynamic config directory (default: `/etc/traefik/dynamic/`, overridable via `TRAEFIK_DYNAMIC_DIR`)
3. Prints `systemctl --user enable --now nexus-dashboard` instructions

### Req-4: build step documented
The dashboard requires a production build before the service starts. `install.sh` prints a clear pre-flight reminder: `cd apps/nextjs && pnpm build` must succeed before enabling the service.

## Scope
- **IN**: `deploy/nexus-dashboard.service`, `deploy/traefik/nexus-dashboard.yml`, `deploy/install.sh` (updated), env var documentation in `config/agents.example.toml`
- **OUT**: Traefik installation/configuration, Tailscale setup, Cloudflare DNS record creation (user tasks), TLS certificate provisioning (handled automatically by Traefik at runtime), Docker or any container runtime

## Impact
| Area | Change |
|------|--------|
| `deploy/nexus-dashboard.service` | New file — systemd unit for `next start` |
| `deploy/traefik/nexus-dashboard.yml` | New file — Traefik router + service config |
| `deploy/install.sh` | Add dashboard install path, `--dashboard` flag |
| `config/agents.example.toml` | Add `NEXUS_AGENTS` env note for dashboard |

## Risks
| Risk | Mitigation |
|------|-----------|
| Traefik cert resolver name differs on homelab | Parameterize via `TRAEFIK_CERT_RESOLVER` env var in the yml, document override |
| `next start` requires a prior `pnpm build` — service fails silently if build missing | ExecStartPre check or bold warning in install output |
| pnpm not on systemd PATH | Service sets explicit PATH including `~/.local/share/pnpm` |
| Traefik dynamic dir path varies by homelab setup | `TRAEFIK_DYNAMIC_DIR` env var in install.sh, default `/etc/traefik/dynamic/` |
