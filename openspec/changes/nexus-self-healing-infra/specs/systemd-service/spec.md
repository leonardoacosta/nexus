## ADDED Requirements

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
