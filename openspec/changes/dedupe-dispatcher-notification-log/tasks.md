---
stack: t3
---
<!-- beads:epic:nx-zi199 -->
<!-- beads:feature:nx-j3mar -->

# Tasks — dedupe-dispatcher-notification-log

## API Batch

- [x] 1.1 Delete the outer `log.info({...}, "socket: notification")` block at `dispatcher.ts:~283-292` (the one at notification-case entry, BEFORE the `deliver()` closure definition). Keep the emission inside `deliver()`. [type:api] [beads:nx-7rj2s]
  - touches: `apps/agent/src/services/socket-server/dispatcher.ts`

## E2E Batch

- [x] 2.1 Verify: `bun test apps/agent/src/services/socket-server` green; `grep -c '"socket: notification"' apps/agent/src/services/socket-server/dispatcher.ts` == 1; paste both. [type:testing] [beads:nx-5fnso]
