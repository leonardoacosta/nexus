# Homelab Postgres Schema Map

> Authoritative ownership map for `homelab-postgres` (pgvector/pgvector:pg16, port 5436).
> Created 2026-05-26 after `nx-dbame` outage; updated 2026-05-27 after homelab PG consolidation
> (`nx-ktlnu` D&D table cleanup + `nx-ebszb` guardian consolidation). `homelab-postgres` is now
> the **sole** PG instance on homelab — `guardian-db` and `nx-postgres-test-1` decommissioned.

## Container Profile

| Field | Value |
| --- | --- |
| Container name | `homelab-postgres` |
| Image | `pgvector/pgvector:pg16` |
| Host port | `5436` |
| Internal port | `5432` |
| Compose file | `~/dev/hl/homelab/compose/cortex.yml` (despite the name — container is shared) |
| Named volume | `cortex-postgres` (Docker local driver) |
| Init env | `POSTGRES_USER=cortex`, `POSTGRES_PASSWORD=cortexdev`, `POSTGRES_DB=cortex` (single-DB init; others created post-hoc) |

## Database Ownership

| Database | Owning App | Owning User | Purpose | Lifecycle |
| --- | --- | --- | --- | --- |
| `cortex` | Cortex CX stack (`~/dev/cx`, dashboards disabled per `hl-51x`) | `cortex` | Stack-specific tables for CX services (CO/CW/CL) when active. ~7.7MB on disk despite "disabled" — retained for rollback. | Created at container init |
| `immich` | Immich (`~/dev/hl/homelab/compose/photos.yml`) | `immich` (separate role) | Photo backup metadata | Created post-init |
| `nexus` | Nexus agent (`~/dev/nx`, `apps/agent`) | `cortex` (shared role, isolated schema) | Sessions, events, health snapshots, notifications, hooks. 20 tables, ~54MB live data (757 sessions, 24k snapshots, 1.8k notifications, 13k projects as of 2026-05-27). | Created post-init; schema applied via `drizzle-kit push` |
| `nova` | **Unknown — orphan** | `cortex` | No active service references this DB. ~11MB on disk. See `nx-vlo2p`. | Created post-init, never adopted |
| `guardian` | Guardian web (`~/dev/gd`, not yet deployed) | `guardian` (dedicated role) | Empty placeholder for future guardian-web deploy. Schema applied on first `db:push`. | Created 2026-05-27 during `nx-ebszb` consolidation |

## Schema Boundary Rules

1. **Each app writes ONLY to its own database.** Cross-database writes are banned. If app A needs data from app B, expose it via API.
2. **Drizzle schemas for Nexus live in `packages/db/src/schema/`.** Migrations target `nexus` DB only — never `cortex`, `immich`, `nova`, or `guardian`.
3. **Adding a new app to the homelab?** Create a new database inside `homelab-postgres` via `CREATE DATABASE <app>` rather than spinning up a new container, unless workload isolation (memory, CPU, vacuum cadence) justifies it.
4. **New apps get dedicated PG roles.** `guardian` was provisioned with its own role on 2026-05-27 — the precedent going forward. Legacy: `cortex` user owns `cortex` + `nexus` DBs (predates the rule). Migrating Nexus to a dedicated role is a future cleanup, not blocking.

## Connection Strings

```bash
# Canonical Nexus agent connection (homelab loopback)
POSTGRES_URL=postgres://cortex:cortexdev@localhost:5436/nexus

# Same target from Mac over Tailscale (used by drizzle-kit push during deploy)
POSTGRES_URL=postgres://cortex:cortexdev@100.73.182.4:5436/nexus

# Reference template
deploy/secrets.env.example
```

## Migration Workflow

**Canonical (Mac → homelab over Tailscale)**: UFW on homelab allows `:5436/tcp` on `tailscale0` (rule comment `PG from Tailscale peers for drizzle-kit (nx-k0kbr)`, shipped 2026-05-27). Tailscale ACLs gate which devices can reach homelab; the UFW allow is defense-in-depth on top of the ACL. Run `pnpm db:migrate` directly from Mac:

```bash
# 1. On Mac — generate the migration file from schema diff (local, no DB needed)
cd /Users/leonardoacosta/dev/nx
pnpm --filter @nexus/db db:generate

# 2. Commit + push the new ./drizzle/NNNN_*.sql migration

# 3. Apply directly from Mac against homelab Postgres over Tailscale
POSTGRES_URL="postgres://cortex:cortexdev@100.73.182.4:5436/nexus" \
  pnpm --filter @nexus/db db:migrate

# Drizzle records the migration in drizzle.__drizzle_migrations automatically.
```

**Fallback (no Tailscale, or UFW rule absent)**: apply via `docker exec` from inside the homelab. Use this if you're operating from a non-Tailscale host or the UFW rule has been removed:

```bash
ssh nyaptor@100.73.182.4 'cd ~/dev/nx && git pull && docker exec -i homelab-postgres psql -U cortex -d nexus < packages/db/drizzle/NNNN_*.sql'
# When applying SQL directly, insert into drizzle.__drizzle_migrations manually using the sha256 of the file content + folderMillis.
```

```bash
# Verify schema landed (either path):
ssh nyaptor@100.73.182.4 'docker exec homelab-postgres psql -U cortex -d nexus -c "\dt"'
```

## Operational Notes

- **Single-DB init artifact**: Container was originally provisioned with `POSTGRES_DB=cortex` (single DB). The `nexus`, `immich`, `nova`, and `guardian` databases were created via subsequent `CREATE DATABASE` calls — there is no init script that re-creates them if the volume is destroyed. Future-proofing: add a `docker-entrypoint-initdb.d/01-create-databases.sql` to the compose or migrate to `POSTGRES_MULTIPLE_DATABASES` pattern.
- **Resolved 2026-05-27 — schema cohabitation cleanup**: Prior to today, the `nexus` database contained 112 tables — 21 Nexus + 91 dormant tables from a D&D/TTRPG campaign manager + better-auth schema. The D&D tables were empty (0 rows) and unreferenced. `nx-ktlnu` deleted all 92 with full backups at `~/backups/dd-{data,schema}-backup-20260527.sql` on homelab. `nexus` DB now holds 21 Drizzle tables + `drizzle.__drizzle_migrations` after `nx-fbje2` applied the missing `0039_safe_may_parker.sql` (credential_swaps).
- **Consolidation 2026-05-27 (`nx-ebszb`)**: Decommissioned `guardian-db` (timescale/timescaledb-ha:pg16, was port 5437) and `nx-postgres-test-1` (postgres:16-alpine, was port 5433, exited 4wk). Guardian DB now lives in `homelab-postgres` as an empty placeholder. `guardian-pgdata` volume retained until 2026-05-28 as rollback surface; safe to delete after. `~/dev/gd/docker-compose.yml` updated and committed locally on homelab as `b7b2abe` (not pushed — Leo's call).
- **Terraform module `infra/modules/homelab-postgres`** (commit `69d34d5b`, 2026-04-06) defines `postgresql_database.nexus` + `postgresql_role.nexus` resources but was never applied (no `terraform.tfstate`). Reality has now diverged further (D&D delete + guardian DB + guardian role exist beyond the module's spec). Treat the module as documentation only until someone reconciles it with current state.
- **Backup strategy**: Currently none for live data. The `cortex-postgres` named volume is a single point of failure for 5 databases. The D&D and consolidation cleanups produced ad-hoc snapshots at `~/backups/` on homelab. A regular `pg_dumpall` cron job or volume-snapshot backend is a P3 follow-up.

## Drift Detection

`deploy/install.sh` runs an env drift check at install time, comparing `~/.env` keys against `deploy/secrets.env.example`. If you see `[WARN env-drift]` lines during install, fix `~/.env` before proceeding — they are why production silently breaks.

The agent itself runs a startup schema smoke test (`verifySchema()`) that refuses to bind :7400 if any required table is missing. Override with `NEXUS_SKIP_SCHEMA_CHECK=1` for tests only.

## Related Issues

| Issue | Status | Topic |
| --- | --- | --- |
| `nx-dbame` | closed | Original 2026-05-26 outage that triggered this doc |
| `nx-ninsg` | closed | Agent startup schema verify (`verifySchema()` in `apps/agent/src/db/database.ts`) |
| `nx-9dkx6` | closed | Systemd dependency cycle fix on homelab |
| `nx-ktlnu` | closed | D&D table cleanup (92 dormant tables dropped, backups preserved) |
| `nx-ebszb` | closed | Guardian + nx-postgres-test consolidation |
| `nx-vmsd6` | closed (resolved by `nx-ktlnu`) | 112-table cohabitation investigation |
| `nx-fbje2` | closed | `credential_swaps` drift resolved by applying `0039_safe_may_parker.sql` |
| `nx-zg9mr` | closed | `RemainOnExit` typo fixed |
| `nx-vlo2p` | open P3 | `nova` orphan database — decide archive / keep / drop |
| `nx-k0kbr` | closed | UFW :5436 on tailscale0 opened; Mac-side `pnpm db:migrate` verified end-to-end |
