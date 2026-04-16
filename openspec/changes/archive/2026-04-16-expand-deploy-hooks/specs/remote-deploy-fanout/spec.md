# remote-deploy-fanout — Spec Delta

## ADDED Requirements

### Requirement: DB migration on packages/db changes

A `deploy/hooks.d/post-merge/03-migrate` script MUST run `pnpm --filter @nexus/db db:push` when files under `packages/db/` change between `ORIG_HEAD` and `HEAD`. The script MUST source `infra/.tf-outputs.env` to load `POSTGRES_URL` if available. Failures log warnings but never block subsequent hooks.

#### Scenario: schema change triggers migration
- **Given** a merge introduces a new column in `packages/db/src/schema/credentials.ts`
- **When** the post-merge dispatcher runs the 03-migrate hook
- **Then** `pnpm --filter @nexus/db db:push` runs and the new column appears in Postgres

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
