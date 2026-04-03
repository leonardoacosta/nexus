# Tasks: Central Database on Homelab

## Phase 1: Schema + Role

- [ ] Add `Datastore` variant to `AgentRole` in `nexus-core/config.rs`
- [ ] Update `agents.toml` parsing to accept `role = "datastore"`
- [ ] Add migration V4: `agent TEXT` column to `health_samples`, `sessions`, `cron_runs`, `agent_lifecycle`
- [ ] Ensure all insert functions pass `agent` parameter

## Phase 2: Ingest Endpoint

- [ ] Add `POST /ingest` handler to `http_handlers.rs` (datastore-only, role-gated)
- [ ] Define `IngestPayload` struct: batched inserts for all 12 tables
- [ ] Validate + insert into local SQLite with transaction
- [ ] Add rate limiting / auth (use existing `secret` from agents.toml)

## Phase 3: Remote Agent Writes

- [ ] Create `DbClient` abstraction: local SQLite for datastore, HTTP for others
- [ ] Buffer writes in-memory when datastore unreachable (bounded VecDeque, max 1000)
- [ ] Flush buffer on reconnect (30s retry loop)
- [ ] Update all services (GitWatch, SpecWatcher, CredentialPool, HealthCollector) to use `DbClient`

## Phase 4: TUI Migration

- [ ] Add `datastore_url` to TUI config (derived from agents.toml role)
- [ ] Replace gRPC fan-out for data views with HTTP queries to datastore
- [ ] Keep gRPC `StreamEvents` for real-time session updates (both agents)
- [ ] Keep gRPC direct-to-agent for Attach/SSH

## Phase 5: Cleanup

- [ ] Remove per-agent DB initialization for non-datastore roles
- [ ] Remove TUI-side result stitching logic
- [ ] Update architecture docs
- [ ] Add integration tests for ingest endpoint
