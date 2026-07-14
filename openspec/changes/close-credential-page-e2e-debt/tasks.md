<!-- beads:epic:nx-auq37 -->
<!-- beads:feature:nx-nigv4 -->

# Implementation Tasks

## E2E Batch

- [ ] [4.1] E2E: warning banner renders when the nexus-agent is stopped/unreachable, credentials table not rendered (nx-ufde) [owner:e2e-engineer] [type:testing] [beads:nx-ndsuv]
- [ ] [4.2] E2E: page header shows "via <agent-name>" source attribution when the agent is running and reachable (nx-t6sw) [owner:e2e-engineer] [type:testing] [beads:nx-sb6gj]
- [ ] [4.3] E2E: MCP full-name colored pills render for a credential row with multiple providers (nx-yad4) [owner:e2e-engineer] [type:testing] [beads:nx-6ci0x]
- [x] [4.4] E2E: a `cc_profile_events` row (renamed from `credential_events`) is populated after both lease and release (nx-b0ew) [owner:e2e-engineer] [type:testing] [beads:nx-owo7j] — real-PG Bun test `apps/agent/src/credentials/pool/pool-core-lifecycle-events.test.ts`: `CredentialPool.lease()` emits a "leased" row, `.release()` emits a "released" row (1 pass, NEXUS_PG_TESTS=1).
