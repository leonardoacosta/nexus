# systemd-service — Spec Delta

## MODIFIED Requirements

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
