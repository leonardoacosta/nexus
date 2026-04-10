# Implementation Tasks

<!-- beads:epic:nx-dso8 -->

## DB Batch

- [x] [1.1] [P-1] Migrate all 17 timestamp columns in packages/db/src/schema/ from mode: "string" to mode: "date" [owner:db-engineer] [beads:nx-3bl2]
- [x] [1.2] [P-1] Add createdAt/updatedAt audit fields to credentials table [owner:db-engineer] [beads:nx-ezoa]
- [x] [1.3] [P-2] Generate Drizzle migration for timestamp mode changes and credential audit fields [owner:db-engineer] [beads:nx-sqom]
- [x] [1.4] [P-2] Update all code consuming timestamp fields as strings to use Date objects (grep for .toISOString, new Date(), date parsing) [owner:db-engineer] [beads:nx-6431]

## API Batch

- [x] [2.1] [P-1] Create fetchWithTimeout utility in packages/core exporting fetch wrapper with AbortController + configurable timeout [owner:api-engineer] [beads:nx-uijn]
- [x] [2.2] [P-1] Fix 4 SQL interpolation findings in apps/agent/src/credentials/pool.ts (lines 115, 230, 332, 333) — use parameterized queries [owner:api-engineer] [beads:nx-9zqz]
- [x] [2.3] [P-1] Batch N+1 credential cleanup — replace SELECT + N UPDATEs with single inArray() batch in pool.ts:277-307 [owner:api-engineer] [beads:nx-s3hg]
- [x] [2.4] [P-1] Extract route table pattern: create apps/agent/src/router.ts with declarative route registration and withErrorHandler wrapper [owner:api-engineer] [beads:nx-bxqb]
- [x] [2.5] [P-1] Extract WebSocket lifecycle from server.ts into apps/agent/src/server-websocket.ts (ServerState, ping/pong, federation) [owner:api-engineer] [beads:nx-rju5]
- [x] [2.6] [P-2] Migrate all 54 routes from if/else chain to route table registration in router.ts [owner:api-engineer] [beads:nx-3i8y]
- [x] [2.7] [P-2] Remove duplicate credential ID pre-validation (server.ts:407-429) — route-level checks are sufficient [owner:api-engineer] [beads:nx-05uc]
- [x] [2.8] [P-2] Defer singleton creation in server.ts — move ServerState.create(), HealthCollector.start(), StreamManager to startServer() [owner:api-engineer] [beads:nx-hv1o]
- [x] [2.9] [P-2] Delete AppContext: remove context.ts, context.test.ts, ctx parameter from startServer/createRequestHandler, AppContext creation from index.ts [owner:api-engineer] [beads:nx-0nfv]
- [x] [2.10] [P-2] Remove duplicate ProjectRules interface from services/command-handler.ts:43-48 [owner:api-engineer] [beads:nx-b3lk]
- [x] [2.11] [P-2] Remove duplicate DedupMap from routes/notifications.ts:36-68 (keep the one that's actually used, remove the unused copy from context.ts or vice versa) [owner:api-engineer] [beads:nx-vyud]
- [x] [2.12] [P-2] Replace all bare fetch() calls in apps/agent/ with fetchWithTimeout (estimated 20+ call sites) [owner:api-engineer] [beads:nx-pejm]
- [x] [2.13] [P-2] Fix 27 unhandled promise rejections — add .catch() or convert to async/await in server.ts, CommandPalette.tsx, LazyTerminalPanel.tsx, and 4 other files [owner:api-engineer] [beads:nx-dghr]
- [x] [2.14] [P-2] Replace sync I/O (readFileSync/writeFileSync) with async variants in non-test files across apps/agent/ and apps/nexus-register/ [owner:api-engineer] [beads:nx-h30s]
- [x] [2.15] [P-1] Write nexus-status Bun replacement (~100 LOC): fetch session summary + API usage from agent HTTP API with NEXUS_ATTACH_SECRET header, render statusline string [owner:api-engineer] [beads:nx-ks0l]

## UI Batch

- [ ] [3.1] [P-1] Fix 8 cross-boundary imports in apps/nextjs — route DB access through @nexus/db public barrel (db.ts:1-2, get-client.ts:4, + 5 more) [owner:ui-engineer] [beads:nx-cagm]
- [ ] [3.2] [P-1] Replace bare fetch() calls in apps/nextjs/ with fetchWithTimeout (estimated 44+ call sites in agent-client.ts, XTerminal.tsx, etc.) [owner:ui-engineer] [beads:nx-4yqc]
- [ ] [3.3] [P-2] Replace console.warn in HealthPoller.tsx:55 with structured logger [owner:ui-engineer] [beads:nx-0kkr]
- [ ] [3.4] [P-2] Remove as any assertions in agent-client.test.ts:327,353 — add proper typing [owner:ui-engineer] [beads:nx-n271]

## Cleanup Batch

- [ ] [4.1] [P-1] Delete crates/nexus-register/ (92 LOC — broken, uses gRPC) [owner:api-engineer] [beads:nx-kc5q]
- [ ] [4.2] [P-1] Delete crates/nexus-mcp/ (649 LOC — no Cargo workspace) [owner:api-engineer] [beads:nx-n0s9]
- [ ] [4.3] [P-1] Delete crates/archive/ (empty directory) [owner:api-engineer] [beads:nx-tuc5]
- [ ] [4.4] [P-1] Delete packages/core/src/generated/ (7,733 LOC protobuf, zero consumers) [owner:api-engineer] [beads:nx-axno]
- [ ] [4.5] [P-1] Remove ProtoSession and ProtoMachineHealth re-exports from packages/core/src/types/ [owner:api-engineer] [beads:nx-m8bw]
- [ ] [4.6] [P-1] Delete proto/ directory and remove proto:codegen script from root package.json [owner:api-engineer] [beads:nx-gkbq]
- [ ] [4.7] [P-2] Delete crates/nexus-status/ after Bun replacement is verified (task 2.15) [owner:api-engineer] [beads:nx-o2q9]
- [ ] [4.8] [P-2] Add 14 missing env vars to .env.example with descriptions (CLAUDE_SESSION_ID, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, + 11 more) [owner:api-engineer] [beads:nx-nlww]
- [ ] [4.9] [P-2] Remove TODO/FIXME comments in agent-client.ts:23,217 and ProjectCard.tsx:22 — implement or delete [owner:ui-engineer] [beads:nx-twli]
- [ ] [4.10] [P-2] Remove commented-out code blocks in server.test.ts:166,385 [owner:api-engineer] [beads:nx-v145]
