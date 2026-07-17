## ADDED Requirements

### Requirement: Remote deploy fan-out SHALL retry a failed remote with capped backoff

`deploy/hooks.d/post-merge/02-deploy`'s remote SSH fan-out MUST retry a failed remote deploy
attempt up to 3 total attempts with backoff (10s, 30s) before logging failure and sending the
"Deploy FAILED on $target" notification. A remote that fails all attempts is reported exactly
once (no duplicate failure notifications per attempt).

#### Scenario: Transient SSH failure recovers on retry

- **GIVEN** a remote agent's SSH connection fails on the first attempt (e.g. a momentary network
  blip) but succeeds on the second
- **WHEN** the post-merge fan-out runs
- **THEN** the deploy succeeds and the "Deploy succeeded on $target" notification fires exactly
  once, with no failure notification for the first attempt

#### Scenario: Persistent failure exhausts retries and alerts once

- **GIVEN** a remote agent is unreachable for all 3 attempts
- **WHEN** the post-merge fan-out runs
- **THEN** the hook waits 10s then 30s between attempts
- **AND** exactly one "Deploy FAILED on $target" notification fires after the third attempt
- **AND** other remotes in the fan-out are unaffected (attempted independently)

### Requirement: A weekly cron job SHALL detect remote deploy staleness

The nexus-agent `CronService` SHALL register a `deploy-staleness` job (weekly, following the
existing `drift`/`reaper` cadence pattern) that, for each remote agent in `agents.toml`, compares
the remote's currently-deployed `git rev-parse HEAD` (via SSH) against the local machine's HEAD.
A remote whose HEAD has differed from local for longer than a 24-hour grace window is considered
stale. Detection and notification follow the exact `checkReaperHeartbeat` /
`emitStaleHeartbeatNotification` shape: persisted last-known-good state via `cron_runs`
(`job="deploy-staleness"`), and a notification cooldown (12h) to avoid duplicate alerts during a
multi-day outage.

#### Scenario: All remotes in sync

- **GIVEN** every remote agent's deployed HEAD matches the local machine's HEAD
- **WHEN** the `deploy-staleness` job runs
- **THEN** a `cron_runs` row is written with `job="deploy-staleness"`, `status="success"`
- **AND** no notification is emitted

#### Scenario: A remote has been stale for over 24 hours

- **GIVEN** a remote agent's deployed HEAD has differed from local HEAD continuously for more
  than 24 hours (confirmed via prior `cron_runs` rows showing the same mismatch across runs)
- **WHEN** the `deploy-staleness` job runs
- **THEN** a notification fires naming the stale remote and the age of the drift
- **AND** a second run within the 12h cooldown window does not re-fire the notification

#### Scenario: A remote is unreachable

- **GIVEN** SSH to a remote agent times out during the staleness check
- **WHEN** the `deploy-staleness` job runs
- **THEN** the job logs the unreachable remote and continues checking the remaining remotes
- **AND** does not crash the cron job or block other scheduled jobs
