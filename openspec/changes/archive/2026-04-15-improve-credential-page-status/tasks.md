# Implementation Tasks

<!-- beads:epic:nx-g4wy -->

## DB Batch

(no DB changes required)

## API Batch

- [x] [2.1] [P-1] Enrich `fetchCredentials()` return type with `agentReachable: boolean` and `failedAgents: string[]`; track reachability through the agent loop [owner:api-engineer] [beads:nx-tv35]
- [x] [2.2] [P-1] Add `failedAgents` population: push `"<name> (<host>:<port>)"` for each agent that fails or times out [owner:api-engineer] [beads:nx-8tor]

## UI Batch

- [x] [3.1] [P-1] Create warning banner component for agent-unreachable state with failed agent list [owner:ui-engineer] [beads:nx-2flp]
- [x] [3.2] [P-1] Update credential page to branch on `agentReachable`: show banner (false) vs table/empty (true) [owner:ui-engineer] [beads:nx-lzud]
- [x] [3.3] [P-2] Add "via <agentSource>" attribution to the page header when credentials load successfully [owner:ui-engineer] [beads:nx-hu52]

## Ops Batch

- [x] [5.1] [P-1] Change `Restart=on-failure` to `Restart=always` in nexus-agent.service and add `StartLimitBurst=5` + `StartLimitIntervalSec=60` [owner:devops-engineer] [beads:nx-w8jg]

## E2E Batch

- [ ] [4.1] [deferred] Verify credential page shows warning banner when agent is stopped [owner:e2e-engineer] [beads:nx-ufde]
- [ ] [4.2] [deferred] Verify credential page shows "via <agent>" attribution when agent is running [owner:e2e-engineer] [beads:nx-t6sw]
