## ADDED Requirements

### Requirement: deploy/nexus-dashboard.service unit ships with hardened defaults

`deploy/nexus-dashboard.service` MUST exist as a systemd user unit that runs the Next.js dashboard from `apps/nextjs/` on port 3100, mirroring the hardening style of `nexus-agent.service`.

The unit MUST declare:

- `Description=Nexus Dashboard — Next.js web UI`
- `After=network-online.target` and `Wants=network-online.target` (Tailscale is NOT required for the dashboard process itself; clients reach it via Tailscale, but the listener does not need tailscaled before it can bind `127.0.0.1:3100`)
- `Type=simple`
- `WorkingDirectory=%h/dev/nx/apps/nextjs`
- `ExecStart=` invokes the pnpm-installed `next` binary on port 3100 (e.g. `/usr/bin/env node ./node_modules/next/dist/bin/next start --port 3100` or `pnpm --filter @nexus/nextjs start`)
- `Environment=PORT=3100`
- `Environment=NODE_ENV=production`
- `Environment=PATH=` including `%h/.local/share/pnpm`, `%h/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
- `EnvironmentFile=-%h/.env` so machine-local secrets (`NEXUS_AGENTS`, etc.) load
- `Restart=always`, `RestartSec=5`, `StartLimitBurst=5`, `StartLimitIntervalSec=60` (same restart-loop bounds as the agent unit)
- `NoNewPrivileges=true`, `ProtectSystem=strict`, `ReadOnlyPaths=/home`
- `ReadWritePaths=%h/dev/nx/apps/nextjs/.next` (Next.js build cache + per-request artifacts)
- `ReadWritePaths=%h/.cache` (Next.js runtime cache fallback)
- `ReadWritePaths=/tmp`
- `[Install] WantedBy=default.target`

#### Scenario: service starts next on port 3100

- **GIVEN** the dashboard unit is installed and `apps/nextjs/.next/` exists from a prior `pnpm --filter @nexus/nextjs build`
- **WHEN** `systemctl --user start nexus-dashboard.service`
- **THEN** `curl http://localhost:3100` returns HTTP 200 within 10 seconds
- **AND** `systemctl --user show nexus-dashboard.service -p NoNewPrivileges` reports `yes`

#### Scenario: service restarts after SIGKILL within restart-loop bounds

- **GIVEN** the dashboard service is active
- **WHEN** the dashboard process is killed with `SIGKILL`
- **THEN** systemd restarts it within `RestartSec=5` seconds
- **AND** if the process is killed 5 times within 60 seconds the unit is marked `failed` (StartLimitBurst enforcement)

---

### Requirement: deploy/traefik/nexus-dashboard.yml provides the upstream route

`deploy/traefik/nexus-dashboard.yml` MUST exist as a Traefik file-provider (dynamic) configuration declaring a router and service for the dashboard host.

The file MUST declare:

- A `http.routers.nexus-dashboard` entry matching `Host(\`nexus.leonardoacosta.dev\`)` over the websecure entrypoint with TLS enabled
- A `http.services.nexus-dashboard.loadBalancer.servers` entry pointing at `http://127.0.0.1:3100`
- A cert resolver reference (default `cloudflare`) so Let's Encrypt provisioning is automatic; the resolver name MAY be overridden on the homelab without editing this file

If the homelab Traefik dynamic-config directory (`TRAEFIK_DYNAMIC_DIR`, default `/etc/traefik/dynamic/`) is not present at install time, the install script MUST skip the copy with a warning and MUST NOT fail — this file documents the upstream route the dashboard expects; it does not assume Traefik is installed.

#### Scenario: Traefik picks up the dashboard route on file-watch reload

- **GIVEN** Traefik is configured with the file provider watching `/etc/traefik/dynamic/`
- **WHEN** `deploy/install.sh --dashboard` copies `nexus-dashboard.yml` into that directory
- **THEN** Traefik's dynamic config reload registers a router for `nexus.leonardoacosta.dev` forwarding to `http://127.0.0.1:3100`
- **AND** `curl -H 'Host: nexus.leonardoacosta.dev' https://<homelab>` is reverse-proxied to the dashboard listener

---

### Requirement: install.sh --dashboard wires the unit + preflight on Linux only

`deploy/install.sh --dashboard` MUST become a fully functional install path on Linux and MUST remain a documented no-op on macOS.

The Linux branch MUST:

1. Copy `deploy/nexus-dashboard.service` to `$HOME/.config/systemd/user/nexus-dashboard.service`
2. Copy `deploy/traefik/nexus-dashboard.yml` to `$TRAEFIK_DYNAMIC_DIR/nexus-dashboard.yml` when that directory exists (skip with a warning otherwise — Traefik may live on a peer node)
3. Run `systemctl --user daemon-reload`
4. Print a preflight reminder block that contains both the literal string `pnpm --filter @nexus/nextjs build` and the path `apps/nextjs`, explaining that Next.js requires `.next/` artifacts on disk before the service can start successfully
5. Print the enable command: `systemctl --user enable --now nexus-dashboard.service`

The macOS branch MUST:

- Print: `Dashboard unit Linux-only; macOS reads from agent over Tailscale`
- NOT write any launchd plist, NOT invoke `launchctl`, NOT touch `~/Library/LaunchAgents/`
- Leave `deploy/check-no-mac-daemon.sh` passing

#### Scenario: --dashboard installs the unit and prints the build preflight on Linux

- **GIVEN** a Linux host with `$HOME/.config/systemd/user/` writable and the repo cloned to `~/dev/nx`
- **WHEN** `deploy/install.sh --dashboard` runs
- **THEN** `~/.config/systemd/user/nexus-dashboard.service` exists and matches `deploy/nexus-dashboard.service`
- **AND** stdout contains the literal substring `pnpm --filter @nexus/nextjs build`
- **AND** stdout contains the literal substring `apps/nextjs`
- **AND** stdout contains the enable command `systemctl --user enable --now nexus-dashboard.service`
- **AND** `systemctl --user daemon-reload` exited 0

#### Scenario: --dashboard on macOS prints the Linux-only notice without installing daemons

- **GIVEN** a macOS host
- **WHEN** `deploy/install.sh --dashboard` runs
- **THEN** stdout contains `Dashboard unit Linux-only; macOS reads from agent over Tailscale`
- **AND** `~/Library/LaunchAgents/` is not modified
- **AND** `deploy/check-no-mac-daemon.sh` exits 0
