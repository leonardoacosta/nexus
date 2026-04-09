# Implementation Tasks

<!-- beads:epic:nx-2uz3 -->

## UI Batch

- [ ] [1.1] [P-1] Audit all TUI screens vs dashboard pages: create a coverage matrix mapping each TUI screen (Dashboard, Detail, Health, Projects, Credentials, Specs, Failures) to its Next.js equivalent, noting gaps [owner:ui-engineer]
- [ ] [1.2] [P-1] Add session start action to dashboard: button on project page that calls POST /session/start, spawns claude in selected project, redirects to session detail [owner:ui-engineer]
- [ ] [1.3] [P-1] Add session stop action to dashboard: stop button on session detail page that calls the existing stop endpoint, confirms with dialog, updates UI on completion [owner:ui-engineer]
- [ ] [1.4] [P-2] Add spec velocity page: `apps/nextjs/src/app/specs/page.tsx` — fetch GET /analytics/specs, render timeline chart showing spec throughput per week [owner:ui-engineer]
- [ ] [1.5] [P-2] Add failure trends page: `apps/nextjs/src/app/failures/page.tsx` — fetch GET /analytics/lifecycle (failure subset), render trend chart with error categorization [owner:ui-engineer]
- [ ] [1.6] [P-2] Add command execution to project detail: dropdown of available commands from GET /commands, execute via POST /project/{code}/run, show output in modal [owner:ui-engineer]
- [ ] [1.7] [P-3] Verify dashboard command palette (Cmd+K) covers TUI keyboard shortcuts: session navigation, project switching, quick actions [owner:ui-engineer]

## API Batch

- [ ] [2.1] [P-1] Remove gRPC server code from Rust agent: delete `crates/nexus-agent/src/grpc/` directory, remove tonic/prost dependencies from `crates/nexus-agent/Cargo.toml`, remove gRPC server startup from `main.rs` [owner:api-engineer]
- [ ] [2.2] [P-1] Remove `proto/nexus.proto` and any proto build scripts [owner:api-engineer]
- [ ] [2.3] [P-2] Archive TUI crate: move `crates/nexus-tui/` to `crates/archive/nexus-tui/`, remove from `Cargo.toml` workspace members list [owner:api-engineer]
- [ ] [2.4] [P-2] Update deploy hooks: remove `cargo build --release -p nexus-tui` and `install nexus` binary from `deploy/hooks.d/pre-push/01-deploy` and `deploy/hooks.d/post-merge/02-deploy` [owner:api-engineer]
- [ ] [2.5] [P-3] Remove `~/.local/bin/nexus` TUI binary from local machine [owner:user]

## E2E Batch

- [ ] [3.1] Verify all new dashboard pages render correctly: session start/stop actions work, spec velocity chart displays, failure trends display, command execution returns output [owner:e2e-engineer]
- [ ] [3.2] Verify Rust agent still starts without gRPC (HTTP-only mode on :7402) — no panics, existing HTTP routes unaffected [owner:e2e-engineer]
