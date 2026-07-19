---
stack: t3
---
<!-- beads:epic:nx-mhv7l -->
<!-- beads:feature:nx-2s455 -->

<!-- stack: one of t3 | cc-meta | effect | dotnet — see commands/apply/references/stacks.md § "Stack vocabulary crosswalk" for the full tasks.md-stack:/--stack-profile/detect_stack() mapping -->

# Implementation Tasks

## API Batch

- [ ] [1.1] Add the two missing routes (`POST /apns/register`, `POST /capture`) to `LEGACY_DISPATCH_ROUTES` in `apps/agent/src/server-request-handler.ts`; rewrite the stale header comment to stop citing the deleted `routes.ts` typed table. See proposal.md ## Motivation for the exact drift. [beads:nx-nly4j]
- [ ] [1.2] Extract a shared response-wrapper helper in `apps/agent/src/server-request-handler.ts` replacing the 57 duplicated `.then().catch()` blocks, preserving every route's exact fail mode. See design.md ## Section: Fail-mode inventory for the full per-route enumeration to preserve. [beads:nx-5osg3]
  - depends on: 1.1
- [ ] [1.3] Add `apps/agent/src/server-request-handler-route-parity.test.ts`, a bun test asserting `LEGACY_DISPATCH_ROUTES` exactly matches the routes dispatched by `handleRequestInner`, failing loudly (named routes) on drift. See design.md ## Section: Parity test design. [beads:nx-o1yvr]
  - depends on: 1.2
- [ ] [1.4] Run `cd apps/agent && bun test`, paste passing output, confirm the new parity test and all existing route tests are green. [beads:nx-tqoo0]
  - depends on: 1.3
