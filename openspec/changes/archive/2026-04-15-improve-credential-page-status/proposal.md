# Proposal: Improve Credential Page Status Awareness

## Change ID
`improve-credential-page-status`

## Summary
Distinguish "agent unreachable" from "no credentials" on the web credential page, show the responding agent name, and harden the agent systemd service to auto-restart on clean exits.

## Context
- Extends: `apps/nextjs/src/app/credentials/page.tsx`, `apps/nextjs/src/app/actions/credentials.ts`
- Extends: `deploy/` systemd unit (nexus-agent.service)
- Related: `credential-http-endpoint` spec (agent-side contract), `credential-pool` spec (pool lifecycle)

## Why
The credential page currently shows "No credentials found" whether the agent is unreachable or the database is genuinely empty. This led to a 17-hour blind spot where the agent had exited cleanly (status=0) and `Restart=on-failure` didn't trigger a restart, but the dashboard showed no indication of agent failure. Users see a misleading empty state instead of an actionable error.

## Requirements

### Requirement: Distinct agent-unreachable error state
The credential page MUST show a distinct error banner when no agent responds, separate from the empty-data message. The banner MUST include the host and port that failed to respond.

### Requirement: Agent source attribution
When credentials load successfully, the page header MUST display the name of the agent that served the data (e.g., "via omarchy").

### Requirement: Agent auto-restart on clean exit
The nexus-agent systemd service MUST restart on any exit, including clean (status=0) exits. The current `Restart=on-failure` policy misses clean shutdowns, leaving the agent dead until manual intervention.

## Scope
- **IN**: Credential page error states, agent source display, fetchCredentials return type enrichment, nexus-agent.service restart policy
- **OUT**: Agent health checks beyond simple reachability, retry/reconnect logic in the browser, credential-swap-endpoint work, dashboard service restart policy

## What Changes
| Area | Change |
|------|--------|
| `apps/nextjs/src/app/actions/credentials.ts` | Add `agentReachable` flag + `failedAgents` list to return type |
| `apps/nextjs/src/app/credentials/page.tsx` | Render error banner vs empty state based on `agentReachable` |
| `nexus-agent.service` (systemd unit) | Change `Restart=on-failure` to `Restart=always` |

## Risks
| Risk | Mitigation |
|------|-----------|
| `Restart=always` could cause tight restart loops on persistent config errors | `RestartSec=5` already in place; `StartLimitBurst`/`StartLimitIntervalSec` can be added if needed |
| Agent source name could leak internal hostnames | Names come from the agents DB table which is admin-controlled |
