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

### Requirement: No macOS nexus-agent daemon in deploy

The deploy system MUST NOT install a `com.nexus.agent` daemon on macOS. On
`Darwin`, neither `deploy/install.sh` nor the git deploy hooks
(`deploy/hooks.d/pre-push/01-deploy`, `deploy/hooks.d/post-merge/02-deploy`)
SHALL generate a `com.nexus.agent` launchd plist, write to
`~/Library/LaunchAgents/com.nexus.agent.plist`, or invoke `launchctl`
bootstrap/bootout/kickstart for `com.nexus.agent`. The `bootstrap_with_retry`
helper, whose only caller was the removed Darwin branch, MUST be removed from
both hooks. macOS deploy responsibilities are limited to the Swift app
build/install path owned by `env-aware-install-script`.

#### Scenario: pre-push hook runs on macOS

- **GIVEN** a developer pushes from a macOS machine and the pre-push deploy hook fires
- **WHEN** the hook reaches the platform branch for `Darwin`
- **THEN** no `sed` against `deploy/com.nexus.agent.plist` is attempted
- **AND** no file is written to `~/Library/LaunchAgents/com.nexus.agent.plist`
- **AND** the hook completes without error and proceeds to remote fanout

#### Scenario: homelab fans out a deploy to the macbook

- **GIVEN** the homelab agent runs its post-merge deploy and fans out to the macbook
- **WHEN** the downstream macbook deploy runs on `Darwin`
- **THEN** no `com.nexus.agent` launchd plist is generated or bootstrapped
- **AND** the fanout reports success with no `sed: … No such file or directory` error

#### Scenario: install.sh run on a clean Mac

- **GIVEN** `deploy/install.sh` is run on macOS
- **WHEN** the macOS branch executes
- **THEN** it builds/installs the Swift app only
- **AND** it does not generate `~/Library/LaunchAgents/com.nexus.agent.plist`
- **AND** `deploy/` contains no `.plist` files and no `com.nexus.agent` launchctl invocation

### Requirement: nexus-agent.service grants CAP_SYS_PTRACE ambient capability

The `deploy/nexus-agent.service` systemd unit SHALL declare
`AmbientCapabilities=CAP_SYS_PTRACE` so the running agent process can
read `/proc/<pid>/cwd` symlinks for same-user processes regardless of
parent-ancestor relationship. This restores cwd resolution under
kernel.yama.ptrace_scope=1 hardening.

#### Scenario: agent reads cwd from non-descendant CC process

- **GIVEN** a Claude Code process is running on the homelab as the
  same user as nexus-agent.service, started from an ssh shell (NOT
  a descendant of nexus-agent.service)
- **WHEN** the process-watcher invokes `readlinkSync("/proc/<pid>/cwd")`
- **THEN** the call returns the cwd path successfully
- **AND** does NOT throw EACCES

#### Scenario: ptrace_scope kernel hardening remains intact for other processes

- **GIVEN** kernel.yama.ptrace_scope=1 is set system-wide
- **WHEN** any process OTHER THAN the granted-capability nexus-agent
  attempts to read `/proc/<pid>/cwd` for a non-ancestor target
- **THEN** the kernel still blocks it with EACCES
- **AND** only nexus-agent's ambient capability bypasses the check

#### Scenario: ambient capability persists across systemd-reload

- **WHEN** `systemctl --user daemon-reload && systemctl --user restart nexus-agent`
- **THEN** the running unit's `AmbientCapabilities=` shows `cap_sys_ptrace`
- **AND** `systemctl --user show nexus-agent -p AmbientCapabilities`
  contains the capability bit

### Requirement: nexus-agent.service SHALL be monitored by a systemd hardware watchdog

The running agent process SHALL periodically notify systemd of liveness via the
`sd_notify(WATCHDOG=1)` protocol (a datagram write to `$NOTIFY_SOCKET`), and
`deploy/nexus-agent.service` SHALL declare `WatchdogSec=` so systemd force-kills and restarts
the unit if notifications stop arriving. This closes the gap `Restart=always` does not cover: a
process that is alive but hung (event loop blocked, deadlocked connection pool) never exits, so
crash-restart never triggers.

#### Scenario: Healthy agent keeps systemd's watchdog fed

- **GIVEN** `nexus-agent.service` is running with `WatchdogSec=30` set
- **WHEN** the agent's main loop is healthy
- **THEN** the agent writes a `WATCHDOG=1` datagram to `$NOTIFY_SOCKET` at an interval less than
  half of `WatchdogSec` (systemd's own recommended margin)
- **AND** `systemctl --user show nexus-agent -p WatchdogTimestamp` advances on each notify

#### Scenario: A hung agent is killed and restarted

- **GIVEN** `nexus-agent.service` is running with `WatchdogSec=30`
- **WHEN** the agent's main loop hangs and stops sending `WATCHDOG=1` notifications
- **THEN** systemd kills the process once `WatchdogSec` elapses with no notification
- **AND** `Restart=always` (existing requirement) brings the unit back up

#### Scenario: sd_notify is a no-op outside systemd

- **GIVEN** the agent runs without `$NOTIFY_SOCKET` set (e.g. local `bun run dev`, or macOS,
  which has no agent daemon)
- **WHEN** the watchdog-notify helper is invoked
- **THEN** it detects the missing environment variable and returns without attempting a socket
  write or throwing

