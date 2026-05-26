# Homelab Postgres Schema Map

> Authoritative ownership map for `homelab-postgres` (pgvector/pgvector:pg16, port 5436).
> Created 2026-05-26 after `nx-dbame` outage to prevent recurrence of the silent-drift class.

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
| `cortex` | Cortex CX stack (`~/dev/cx`, currently commented out in `cortex.yml`) | `cortex` | Stack-specific tables for CX services (CO/CW/CL) when active | Created at container init |
| `immich` | Immich (`~/dev/hl/homelab/compose/photos.yml`) | `immich` (separate role) | Photo backup metadata | Created post-init |
| `nexus` | Nexus agent (`~/dev/nx`, `apps/agent`) | `cortex` (shared role, isolated schema) | Sessions, events, health snapshots, notifications, hooks | Created post-init; schema applied via `drizzle-kit push` |
| `nova` | **Unknown — orphan** | Unknown | No active service references this DB. See beads issue. | Created post-init, never adopted |

## Schema Boundary Rules

1. **Each app writes ONLY to its own database.** Cross-database writes are banned. If app A needs data from app B, expose it via API.
2. **Drizzle schemas for Nexus live in `packages/db/src/schema/`.** Migrations target `nexus` DB only — never `cortex`, `immich`, or `nova`.
3. **Adding a new app to the homelab?** Create a new database inside `homelab-postgres` via `CREATE DATABASE <app>` rather than spinning up a new container, unless workload isolation (memory, CPU, vacuum cadence) justifies it.
4. **Role sharing is tolerated for dev convenience.** `cortex` user owns `cortex` + `nexus` DBs. Production-grade isolation would mint per-app roles; we accept the trade for now and revisit on multi-tenant scaling.

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

```bash
# From repo root on Mac, target homelab over Tailscale:
POSTGRES_URL="postgres://cortex:cortexdev@100.73.182.4:5436/nexus" \
  pnpm --filter @nexus/db db:push

# Verify schema landed:
ssh nyaptor@100.73.182.4 'docker exec homelab-postgres psql -U cortex -d nexus -c "\dt"'
```

## Operational Notes

- **Single-DB init artifact**: Container was originally provisioned with `POSTGRES_DB=cortex` (single DB). The `nexus`, `immich`, and `nova` databases were created via subsequent `CREATE DATABASE` calls — there is no init script that re-creates them if the volume is destroyed. Future-proofing: add a `docker-entrypoint-initdb.d/01-create-databases.sql` to the compose or migrate to `POSTGRES_MULTIPLE_DATABASES` pattern.
- **Schema cohabitation in `nexus` DB**: As of 2026-05-26, the `nexus` database actually contains 112 tables — far more than the ~13 Drizzle migrations defined in `packages/db/src/schema/`. Likely cohabitation with Cortex tables (both apps share the `cortex` PG role). This violates the "each app writes only to its own database" boundary rule above. Needs investigation — could be intentional integration or accidental drift. **Do NOT run `drizzle-kit push --force` against the `nexus` database until this is resolved** — schema sync would ALTER tables Drizzle doesn't own.
- **Terraform module `infra/modules/homelab-postgres`** (commit `69d34d5b`, 2026-04-06) defines `postgresql_database.nexus` + `postgresql_role.nexus` resources but was never applied (no `terraform.tfstate`). The reality drift was reconciled manually on 2026-05-26 — Terraform would now report state divergence if applied without a refresh.
- **Backup strategy**: Currently none. The `cortex-postgres` named volume is a single point of failure for 4 databases. Snapshot via `pg_dumpall` or move to a backup-friendly volume backend is a P3 follow-up.

## Drift Detection

`deploy/install.sh` runs an env drift check at install time, comparing `~/.env` keys against `deploy/secrets.env.example`. If you see `[WARN env-drift]` lines during install, fix `~/.env` before proceeding — they are why production silently breaks.

The agent itself runs a startup schema smoke test (`verifySchema()`) that refuses to bind :7400 if any required table is missing. Override with `NEXUS_SKIP_SCHEMA_CHECK=1` for tests only.

## Related Issues

- `nx-dbame` — Original outage that triggered this doc
- `nx-9dkx6` — Strategic systemd cycle fix (separate, but blocks any reboot)
- Forthcoming beads — `nova` orphan investigation, CLAUDE.md update tracking
