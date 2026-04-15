# systemd-service Specification

## Purpose
TBD - created by archiving change deploy-dashboard-homelab. Update Purpose after archive.
## Requirements
### Requirement: nexus-dashboard.service unit

`deploy/nexus-dashboard.service` MUST exist and match the hardening pattern of `nexus-agent.service`.

Required fields:
- `Description=Nexus Dashboard — Next.js web UI`
- `After=network-online.target`
- `ExecStart=` runs `next start --port 3100` via the pnpm-installed next binary
- `WorkingDirectory=%h/dev/nx/apps/nextjs`
- `EnvironmentFile=-%h/.env` (loads NEXUS_AGENTS and other secrets)
- `Environment=PORT=3100`
- `Environment=NODE_ENV=production`
- `Environment=PATH=` includes `%h/.local/share/pnpm`, `/usr/local/bin`, `/usr/bin`, `/bin`
- `Restart=on-failure`, `RestartSec=5`
- `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only`
- `ReadWritePaths=%h/dev/nx/apps/nextjs/.next`

#### Scenario: service starts next on port 3100
- **Given** the service is enabled and `apps/nextjs/.next/` exists (build complete)
- **When** `systemctl --user start nexus-dashboard`
- **Then** `curl http://localhost:3100` returns HTTP 200 within 10 seconds

#### Scenario: service restarts after crash
- **Given** the dashboard process is killed with SIGKILL
- **When** 5 seconds elapse
- **Then** systemd has restarted the process and port 3100 is responsive again

---

### Requirement: build pre-flight documented in install.sh

The install script MUST print a pre-flight reminder block when the dashboard service is installed, making clear that `pnpm build` is required before enabling the service.

#### Scenario: install output includes build reminder
- **Given** `deploy/install.sh --dashboard` is run on a fresh homelab clone
- **When** installation completes
- **Then** output includes the text `pnpm build` and the path `apps/nextjs`

---

### Requirement: nexus-agent.service restart policy

The `nexus-agent.service` unit MUST use `Restart=always` instead of `Restart=on-failure` to ensure the agent restarts after any exit, including clean (status=0) shutdowns. `RestartSec=5` MUST remain as backoff. `StartLimitBurst=5` and `StartLimitIntervalSec=60` MUST be added to prevent infinite restart loops during persistent failures.

#### Scenario: agent restarts after clean exit
- **Given** the nexus-agent process exits with status 0
- **When** 5 seconds elapse
- **Then** systemd has restarted the process and port 7400 is responsive

#### Scenario: agent restart loop is bounded
- **Given** the nexus-agent process crashes 5 times within 60 seconds
- **When** the 6th crash occurs
- **Then** systemd stops restarting and marks the unit as failed

