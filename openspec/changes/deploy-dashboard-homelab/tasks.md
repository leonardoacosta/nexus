# Implementation Tasks

<!-- beads:epic:nx-dch -->

## Deploy Batch

- [ ] [1.1] [P-1] Create `deploy/nexus-dashboard.service`: systemd unit running `next start --port 3100`, mirrors nexus-agent.service hardening, loads `~/.env` for NEXUS_AGENTS [owner:devops-engineer] [beads:nx-v6l]
- [ ] [1.2] [P-1] Create `deploy/traefik/nexus-dashboard.yml`: Traefik file-provider config routing `nexus.leonardoacosta.dev` → `localhost:3100` with TLS via `cloudflare` cert resolver [owner:devops-engineer] [beads:nx-b79]
- [ ] [1.3] [P-2] Update `deploy/install.sh`: add `--dashboard` flag, copy service + traefik yml, respect `TRAEFIK_DYNAMIC_DIR` env var, print build pre-flight reminder [owner:devops-engineer] [beads:nx-9c3]
- [ ] [1.4] [P-2] Add `NEXUS_AGENTS` env var example to `config/agents.example.toml` with a note for homelab dashboard deployment [owner:devops-engineer] [beads:nx-a4o]

## User Tasks

- [ ] [2.1] [user] Add Cloudflare DNS A record: `nexus.leonardoacosta.dev` → homelab Tailscale IP (e.g. 100.x.x.x) — DNS-only, no proxy
- [ ] [2.2] [user] Configure Traefik on homelab: add Cloudflare API token to cert resolvers (`CF_DNS_API_TOKEN` env var), ensure file provider watches `/etc/traefik/dynamic/`
- [ ] [2.3] [user] On homelab: `cd ~/dev/nx && git pull && cd apps/nextjs && pnpm build`
- [ ] [2.4] [user] On homelab: run `deploy/install.sh --dashboard` then `systemctl --user enable --now nexus-dashboard`
- [ ] [2.5] [user] Verify: `curl -L https://nexus.leonardoacosta.dev` (over Tailscale) returns the dashboard

## Validation Batch

- [ ] [3.1] [P-1] Validate `deploy/nexus-dashboard.service`: verify all required fields match spec (hardening, env, restart policy, working dir) [owner:devops-engineer] [beads:nx-v2d]
- [ ] [3.2] [P-1] Validate `deploy/traefik/nexus-dashboard.yml`: `yamllint` passes, router/service/tls fields present [owner:devops-engineer] [beads:nx-dyk]
- [ ] [3.3] [P-2] Smoke test install.sh `--dashboard` flag: dry-run on local machine confirms output includes build reminder and correct copy targets [owner:devops-engineer] [beads:nx-s6d]
