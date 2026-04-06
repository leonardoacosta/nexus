## MODIFIED Requirements

### Requirement: Systemd restart-storm guard
`deploy/nexus-dashboard.service` MUST include `StartLimitBurst=5` and `StartLimitIntervalSec=30` under the `[Unit]` stanza.

When the service crashes and restarts five or more times within a 30-second window, systemd MUST:
- Stop issuing automatic restart attempts
- Transition the unit to `failed` state
- Surface the failure visibly via `systemctl --user status nexus-dashboard`

Manual recovery MUST be possible via:
```bash
systemctl --user reset-failed nexus-dashboard && systemctl --user start nexus-dashboard
```

`Restart=always` and `RestartSec=5` MUST be retained — the guard supplements, not replaces, the restart policy.

#### Scenario: Single transient crash — restarts normally
Given `StartLimitBurst=5` and `StartLimitIntervalSec=30` are set,
When the service crashes once and recovers,
Then systemd restarts it after `RestartSec=5` and the restart counter does not reach the burst limit.

#### Scenario: Crash-loop hits burst limit
Given `StartLimitBurst=5` and `StartLimitIntervalSec=30` are set,
When the service crashes five times within 30 seconds,
Then systemd stops automatic restarts and `systemctl --user status nexus-dashboard` shows `failed`.

#### Scenario: Manual recovery after burst limit
Given the service is in `failed` state after hitting `StartLimitBurst`,
When the operator runs `systemctl --user reset-failed nexus-dashboard && systemctl --user start nexus-dashboard`,
Then the service starts normally and the restart counter resets.
