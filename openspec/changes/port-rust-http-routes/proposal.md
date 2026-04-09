# Proposal: Port Rust HTTP Routes to Bun Agent

## Change ID
`port-rust-http-routes`

## Summary
Port all 22 Rust-only HTTP routes from the nexus-agent :7402 server into the Bun agent's HTTP server, consolidating the API surface into a single process and port.

## Context
- Extends: `apps/agent/src/server.ts`, `apps/agent/src/routes/`
- Related: `crates/nexus-agent/src/http_handlers/`, `crates/nexus-agent/src/main.rs` (route setup)

## Motivation
The Rust agent serves 31 HTTP routes on port 7402, of which 22 have no equivalent in the Bun agent. These include spec management (`/specs/*`), analytics (`/analytics/*`), project-level queries (`/project/{code}/*`), command registry (`/commands/*`), and operational endpoints (`/statusline`, `/hooks`, `/environment`, `/failures`, `/cron`, `/events` SSE). The Bun agent already handles sessions, credentials, health, and notifications on port 7400. Porting the remaining routes lets the Bun agent be the single HTTP API surface. Most routes are thin read-through handlers that query SQLite, shell out to CLI tools, or aggregate in-memory state — straightforward to port.

## Requirements

### Req-1: Spec management routes
Port `/specs/all` (list all specs across projects), `GET /specs` (list for current project), `GET /specs/{project}/{name}` (read spec), `PUT /specs/{project}/{name}` (approve/reject), `POST /specs/{project}/{name}/read` (mark read), `GET /specs/{project}/{name}/status` (spec status). Backend: `Bun.spawn('openspec', ...)` subprocess calls.

### Req-2: Analytics routes
Port `GET /analytics/health` (health time-series), `GET /analytics/specs` (spec velocity), `GET /analytics/credentials` (credential polls + swaps), `GET /analytics/git` (git activity), `GET /analytics/lifecycle` (session lifecycle metrics), `GET /analytics/cron` (cron run history). Backend: SQLite queries via the Bun agent's DB layer or Postgres.

### Req-3: Project routes
Port `GET /project/{code}/status` (enriched project status), `GET /project/{code}/beads` (beads issues), `GET /project/{code}/git` (git branch/commit info), `GET /project/{code}/specs` (project specs), `POST /project/{code}/run` (run command in project). Backend: subprocess calls to `bd`, `git`, `openspec`.

### Req-4: Operational routes
Port `GET /statusline` (shell prompt data), `POST /hooks` (hook event ingestion), `GET /recommend` (next-action recommendations), `GET /environment` (env variable cache), `GET /failures` (recent failure buffer), `GET /cron` (cron job status), `GET /events` (SSE event stream), `GET /commands` + `GET/PUT /commands/{name}` (command registry).

### Req-5: Session start route
Port `POST /session/start` (spawn tmux window + claude). This route creates a tmux window and sends keys to start a Claude session. The Bun agent already has terminal management (`apps/agent/src/terminal/`).

## Scope
- **IN**: All 22 Rust-only HTTP routes, matching existing request/response contracts, X-Nexus-Secret auth
- **OUT**: Modifying the Rust agent (removed in Phase 5), changing API contracts, adding new routes not in the Rust agent

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/routes/` | 8-10 new route files covering specs, analytics, projects, commands, operational |
| `apps/agent/src/server.ts` | Register new routes, add SSE support for `/events` |
| `apps/agent/src/services/` | New `command-registry.ts`, `environment-cache.ts`, `failure-buffer.ts` services |

## Risks
| Risk | Mitigation |
|------|-----------|
| API contract drift between Rust and Bun implementations | Port from Rust source as reference; add response schema tests |
| SSE `/events` endpoint requires long-lived connections | Bun handles SSE natively; use `ReadableStream` with event-driven push |
| Subprocess calls (openspec, bd, git) may have different env in Bun vs Rust | Inherit full user env via `Bun.spawn({ env: process.env })` |
