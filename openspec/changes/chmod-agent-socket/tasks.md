---
stack: t3
---
<!-- beads:epic:nx-v0bx9 -->
<!-- beads:feature:nx-ofuw4 -->

# Tasks — chmod-agent-socket

## API Batch

- [x] 1.1 In `apps/agent/src/services/socket-server/server.ts`, after the listen succeeds, `fs.chmodSync(socketPath, 0o600)` (repo 0600 exemplar: `apps/agent/src/cc-credential-manager.ts:194`). Apply on both the default and `NEXUS_SOCKET` paths — the chmod lives in the bind path, not behind a path check. [type:api] [beads:nx-inyc4]
  - touches: `apps/agent/src/services/socket-server/server.ts`
- [x] 1.2 Add a test asserting the bound socket file mode is 0600 (stat the path, mask with 0o777). Follow the harness setup of the existing socket-server suites in the same directory. [type:testing] [beads:nx-yyrel]
  - touches: `apps/agent/src/services/socket-server/server.test.ts`

## E2E Batch

- [ ] 2.1 Verify: `bun test apps/agent/src/services/socket-server`, `pnpm typecheck`, `pnpm lint` green; paste output. [type:testing] [beads:nx-jauok]
