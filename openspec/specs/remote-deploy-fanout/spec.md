# remote-deploy-fanout Specification

## Purpose
TBD - created by archiving change add-remote-deploy. Update Purpose after archive.
## Requirements
### Requirement: The deploy hook MUST fan out to remote agents after local deploy
After local build + service restart, the script MUST iterate non-local agents from agents.toml,
SSH to each, and trigger pull + build + deploy.

#### Scenario: Two agents, local + remote
Given agents.toml has omarchy (local) and macbook (remote)
When a git push triggers the post-merge hook on omarchy
Then omarchy builds locally, then SSHes to macbook and runs deploy

#### Scenario: Remote unreachable
Given macbook is offline or SSH fails
When the deploy hook attempts remote fan-out
Then it logs a warning, sends TTS notification, and exits 0 (does not block)

#### Scenario: Remote build fails
Given macbook is reachable but cargo build fails
When the remote deploy runs
Then the failure is logged and reported via TTS, other remotes still attempted

### Requirement: The deploy hook MUST wait 2 seconds before remote pull
The SSH command MUST sleep 2 seconds before git pull to let the push complete on the remote.

#### Scenario: Timing
Given a push just completed locally
When the remote deploy starts
Then it sleeps 2s, then runs git pull, ensuring the pushed commit is available

### Requirement: Remote deploys MUST run in background
The remote SSH commands MUST be backgrounded so the git hook returns promptly.

#### Scenario: Hook returns fast
Given 3 remote agents are configured
When the local deploy completes
Then remote deploys are launched in background and the hook exits immediately

### Requirement: DB migration on packages/db changes

A `deploy/hooks.d/post-merge/03-migrate` script MUST run `pnpm --filter @nexus/db db:migrate` (ordered migration replay — NEVER `db:push`) when files under `packages/db/` change between `ORIG_HEAD` and `HEAD`, but MUST skip entirely on a non-primary DB-writing machine regardless of whether `packages/db/` changed. The deploy is the single writer to the live DB; schema changes arrive as committed `.sql` migrations generated via `db:generate`. The script MUST load `POSTGRES_URL` from the agent's canonical source (`~/.env`). Failures log warnings but never block subsequent hooks.

#### Scenario: schema change triggers migration
- **Given** a merge introduces a new column in `packages/db/src/schema/credentials.ts`
- **When** the post-merge dispatcher runs the 03-migrate hook
- **Then** `pnpm --filter @nexus/db db:migrate` runs (applying the committed migration) and the new column appears in Postgres

#### Scenario: no DB changes skips migration
- **Given** a merge only changes `apps/nextjs/src/components/`
- **When** the post-merge dispatcher runs the 03-migrate hook
- **Then** the hook detects no `packages/db/` changes and exits early without running drizzle-kit

#### Scenario: missing POSTGRES_URL warns and exits
- **Given** `infra/.tf-outputs.env` does not exist or `POSTGRES_URL` is unset
- **When** the 03-migrate hook runs against a DB schema change
- **Then** the hook logs a warning ("POSTGRES_URL not set, skipping migration") and exits 0

#### Scenario: a non-primary machine skips migration entirely, even with a schema change

- **Given** the current machine is flagged as a non-primary DB-writing host (e.g. the Mac,
  where the homelab primary already applies the shared migration)
- **AND** a merge introduces a schema change under `packages/db/`
- **When** the post-merge dispatcher runs the 03-migrate hook
- **Then** the hook detects the non-primary role and exits early without attempting
  `db:migrate` or requiring `POSTGRES_URL` to be set locally
- **AND** no "POSTGRES_URL is required" error is logged

### Requirement: Dashboard rebuild on Next.js changes

A `deploy/hooks.d/post-merge/04-dashboard` script MUST run `pnpm --filter @nexus/nextjs build` and `systemctl --user restart nexus-dashboard` when files under `apps/nextjs/`, `packages/db/`, or `packages/core/` change. Skips entirely on non-Linux (no nexus-dashboard service on macOS).

#### Scenario: dashboard rebuild on UI change
- **Given** a merge changes `apps/nextjs/src/components/CredentialsTable.tsx`
- **When** the post-merge dispatcher runs the 04-dashboard hook
- **Then** `pnpm --filter @nexus/nextjs build` runs and `systemctl --user restart nexus-dashboard` is called

#### Scenario: dashboard rebuild on shared package change
- **Given** a merge changes `packages/db/src/schema/sessions.ts`
- **When** the post-merge dispatcher runs both 03-migrate and 04-dashboard
- **Then** the migration runs first, then the dashboard rebuilds (since shared types changed)

#### Scenario: no Next.js changes skips rebuild
- **Given** a merge only changes `apps/agent/src/`
- **When** the post-merge dispatcher runs the 04-dashboard hook
- **Then** the hook detects no `apps/nextjs/`, `packages/db/`, or `packages/core/` changes and exits early

---

### Requirement: Rust agent rebuild on crates changes

A `deploy/hooks.d/post-merge/05-rust` script MUST run `cargo build --release -p nexus-agent` and `systemctl --user restart nexus-agent-rust` (or equivalent service name) when files under `crates/` or `Cargo.toml` / `Cargo.lock` change. Skips on macOS.

Note: the Rust agent service may share a name with the Bun agent service. The hook MUST detect the actual installed binary path at `~/.local/bin/nexus-agent-rust` (or the appropriate Rust-specific path) before attempting restart. If no Rust agent service is installed, the hook builds the binary but skips the restart with a warning.

#### Scenario: Rust crate change triggers cargo build
- **Given** a merge changes `crates/nexus-watcher/src/main.rs`
- **When** the post-merge dispatcher runs the 05-rust hook
- **Then** `cargo build --release -p nexus-agent` runs and the binary is installed to `~/.local/bin/`

#### Scenario: no Rust changes skips build
- **Given** a merge only changes `apps/nextjs/`
- **When** the post-merge dispatcher runs the 05-rust hook
- **Then** the hook exits early without invoking cargo

### Requirement: The post-merge deploy hook SHALL recover from a bun.lock frozen-install mismatch

`deploy/hooks.d/post-merge/02-deploy` MUST detect a `bun install --frozen-lockfile` failure
caused by lockfile drift (the committed `bun.lock` no longer matching what `bun install`
resolves) and either regenerate the lockfile safely or surface an actionable, non-silent
recovery signal — `nexus-agent` MUST NOT be left running against a stale `node_modules` with
only a buried warning as the trail.

#### Scenario: Frozen-install failure triggers actionable recovery

- **GIVEN** a merge lands and the committed `bun.lock` no longer matches what `bun install`
  would resolve
- **WHEN** `deploy/hooks.d/post-merge/02-deploy` runs `bun install --frozen-lockfile` and it
  fails with "lockfile had changes, but lockfile is frozen"
- **THEN** the hook either regenerates the lockfile (non-frozen `bun install`, committed
  separately) or surfaces a clearly actionable "manual recovery required" signal at a
  visibility level the operator will actually see (not just a buried log line)
- **AND** `nexus-agent`'s dependency sync completes or the operator is unambiguously alerted
  that it did not

### Requirement: GUI-agent deploy SHALL extend to headless iOS device install

iOS deploys SHALL route through the same GUI-agent kickstart mechanism the macOS deploy already uses (`dev.leonardoacosta.nexus.deploy`, gui/501 LaunchAgent, `deploy/hooks.d/*/04-swift-deploy` + `deploy/lib/macos-swift-deploy.sh`), extended to build `nexus-ios` and run `xcrun devicectl device install app` against the paired iPhone — a headless SSH attempt fails at codesign (requires an Aqua session) and even `git push` from SSH fails with keychain error -25308.

#### Scenario: iOS device install completes without manual devicectl intervention

- **GIVEN** a merge lands changing files under `apps/swift/nexus-ios/`
- **AND** a paired iPhone is reachable via `devicectl`
- **WHEN** the post-merge deploy dispatcher runs the extended `04-swift-deploy` hook
- **THEN** the GUI-agent LaunchAgent builds `nexus-ios` in an Aqua session (real codesign
  succeeds)
- **AND** `xcrun devicectl device install app` installs the signed build to the paired device
- **AND** no manual `devicectl` command from the operator is required

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

