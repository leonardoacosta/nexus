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

A `deploy/hooks.d/post-merge/03-migrate` script MUST run `pnpm --filter @nexus/db db:migrate` (ordered migration replay — NEVER `db:push`) when files under `packages/db/` change between `ORIG_HEAD` and `HEAD`. The deploy is the single writer to the live DB; schema changes arrive as committed `.sql` migrations generated via `db:generate`. The script MUST load `POSTGRES_URL` from the agent's canonical source (`~/.env`). Failures log warnings but never block subsequent hooks.

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

---

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

