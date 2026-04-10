# Implementation Tasks

<!-- beads:epic:nx-2uz3 -->

## UI Batch

- [x] [1.1] [P-1] Audit all TUI screens vs dashboard pages: create a coverage matrix mapping each TUI screen (Dashboard, Detail, Health, Projects, Credentials, Specs, Failures) to its Next.js equivalent, noting gaps [owner:ui-engineer]
- [x] [1.2] [P-1] Add session start action to dashboard: button on project page that calls POST /session/start, spawns claude in selected project, redirects to session detail [owner:ui-engineer]
- [x] [1.3] [P-1] Add session stop action to dashboard: stop button on session detail page that calls the existing stop endpoint, confirms with dialog, updates UI on completion [owner:ui-engineer]
- [x] [1.4] [P-2] Add spec velocity page: `apps/nextjs/src/app/specs/page.tsx` — fetch GET /specs/all, render table showing specs per project [owner:ui-engineer]
- [x] [1.5] [P-2] Add failure trends page: `apps/nextjs/src/app/failures/page.tsx` — fetch GET /failures, render summary + by-tool + top-errors tables [owner:ui-engineer]
- [x] [1.6] [P-2] Add command execution to project detail: dropdown of available commands from GET /commands, execute via POST /project/{code}/run, show output in modal [owner:ui-engineer]
- [x] [1.7] [P-3] Verify dashboard command palette (Cmd+K) covers TUI keyboard shortcuts: session navigation, project switching, quick actions [owner:ui-engineer]

## API Batch

- [x] [2.1] [P-1] Remove gRPC server code from Rust agent: deleted `crates/nexus-agent/src/grpc/` directory, removed tonic/prost-types from agent deps, removed gRPC server startup and `tonic::transport::Server` from `main.rs`, replaced `tonic::Status` in command_executor with `String`, replaced `prost_types::Timestamp` in registry with `datetime_to_timestamp()`. Agent now runs HTTP-only on :7402. [owner:api-engineer]
- [x] [2.2] [P-1] Remove proto files: deleted `proto/` directory, removed `nexus-core/build.rs` and `tonic-build`/`tonic-prost-build` build-deps. Generated proto types checked in as static `crates/nexus-core/src/proto_generated.rs` (replaces `tonic::include_proto!`). Removed `tonic-build`/`tonic-prost-build`/`prost-build` from workspace deps. [owner:api-engineer]
- [x] [2.3] [P-2] Archive TUI crate: `crates/nexus-tui/` moved to `crates/archive/nexus-tui/`, workspace excludes `crates/archive`. Removed TUI-only workspace deps (ratatui, crossterm, syntect, tui-textarea-2, pulldown-cmark). [owner:api-engineer]
- [x] [2.4] [P-2] Deploy hooks already clean: post-merge hook already removed TUI build/install and protoc step in prior pass. Pre-push hook builds only nexus-agent + nexus-register. [owner:api-engineer]
- [ ] [2.5] [P-3] Remove `~/.local/bin/nexus` TUI binary from local machine [owner:user]

## E2E Batch

- [ ] [3.1] Verify all new dashboard pages render correctly: session start/stop actions work, spec velocity chart displays, failure trends display, command execution returns output [owner:e2e-engineer]
- [ ] [3.2] Verify Rust agent still starts without gRPC (HTTP-only mode on :7402) — no panics, existing HTTP routes unaffected [owner:e2e-engineer]
