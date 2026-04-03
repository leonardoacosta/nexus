# Proposal: Central Database on Homelab

**Change ID:** `refactor-central-db`
**Status:** Draft
**Priority:** P1 — foundational for the other two proposals

## Problem

Each agent maintains its own `nexus.db` SQLite file. 10 of 12 tables contain fleet-level or project-level data (specs, credentials, git events, failures, notifications), not machine-local data. The TUI must fan out gRPC queries to every agent and stitch results client-side. Cross-machine visibility into credentials, usage, spec progress, and failures requires querying N agents.

## Solution

Move SQLite to the homelab agent (`role: datastore`). The homelab is always on — it's infrastructure. The Mac is a laptop that sleeps. All agents write to the central DB via a new `POST /ingest` HTTP endpoint on the datastore. The TUI queries the datastore as the single source of truth for data views.

## Key Design Decisions

### New Role: `datastore`
`agents.toml` gains a new role value. The agent with `role = "datastore"` hosts the central DB and exposes the `/ingest` endpoint. Only one agent should have this role.

```toml
role = "datastore"  # hosts nexus.db, serves /ingest + /analytics
role = "notifier"   # notification delivery (TTS, banners, meeting detection)
role = "agent"      # lightweight, writes to datastore via HTTP
```

### Ingest Endpoint
`POST /ingest` on the datastore accepts batched inserts:
```json
{
  "agent": "homelab",
  "health_samples": [...],
  "sessions": [...],
  "git_events": [...],
  "credential_polls": [...]
}
```

Remote agents call this every 30 seconds or on significant events.

### Schema Changes
- Add `agent TEXT NOT NULL DEFAULT 'unknown'` column to: `health_samples`, `sessions`, `cron_runs`, `agent_lifecycle`
- All other tables are already project-scoped (not machine-scoped)

### Graceful Degradation
When the datastore is unreachable, remote agents buffer writes in-memory (bounded queue, ~1000 events) and flush when connectivity returns. Session registration still works locally via gRPC.

### TUI Query Path
- **Data views** (specs, credentials, analytics, failures): `GET datastore:7402/analytics/*` — single source
- **Real-time sessions**: gRPC `StreamEvents` from all agents (still peer-to-peer for live updates)
- **Attach/SSH**: gRPC directly to the owning agent (unchanged)

## Impact

| Component | Change |
|---|---|
| `nexus-core/db.rs` | Add `agent` column to 4 tables, new migration |
| `nexus-agent/main.rs` | Role-gate DB: datastore opens local file, others skip |
| `nexus-agent/http_handlers.rs` | New `/ingest` endpoint (datastore only) |
| `nexus-agent/services/*` | Services write via HTTP when not datastore role |
| `nexus-core/config.rs` | Add `Datastore` variant to `AgentRole` |
| `nexus-tui/client.rs` | Data queries → datastore HTTP, not gRPC fan-out |

## Out of Scope
- Database replication (Litestream, LiteFS)
- PostgreSQL migration
- Changing the gRPC protocol for session streaming
