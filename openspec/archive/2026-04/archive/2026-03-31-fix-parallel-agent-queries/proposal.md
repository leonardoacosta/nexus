# Proposal: Parallelize agent session queries

## Change ID
`fix-parallel-agent-queries`

## Summary
Fan out `get_sessions` gRPC calls to all agents concurrently instead of querying them one by one, reducing worst-case poll latency from 2*N seconds to 2 seconds.

## Context
- Extends: `crates/nexus-tui/src/client.rs` — `NexusClient::get_sessions` method (line 207)
- Related: none (no prior specs)

## Motivation
`get_sessions()` iterates agents sequentially with a `for` loop. Each agent has a 2-second connect and 2-second request timeout. With N agents, one unreachable agent blocks the entire poll cycle for up to 2 seconds before moving to the next. With 5 agents where 2 are dead, the poll cycle stalls for 4+ seconds, making the TUI feel unresponsive. Parallel fan-out ensures the total wait is bounded by the single slowest agent (max 2 seconds) regardless of fleet size.

## Requirements
### Req-1: Concurrent agent queries
`get_sessions` SHALL query all agents concurrently rather than sequentially. The total wall-clock time SHALL be bounded by the single slowest agent response, not the sum of all agent response times.

### Req-2: Preserve existing error handling
When an individual agent query fails, the agent SHALL be marked `Disconnected` and contribute an empty session list, identical to current behavior. Failures on one agent SHALL NOT affect results from other agents.

## Scope
- **IN**: `NexusClient::get_sessions` method — refactor from sequential to concurrent fan-out
- **OUT**: `get_session` (single-session lookup), connection/reconnection logic, timeout values

## Impact
| Area | Change |
|------|--------|
| `crates/nexus-tui/src/client.rs` | Refactor `get_sessions` to use `tokio::task::JoinSet` or similar for concurrent queries |

## Risks
| Risk | Mitigation |
|------|-----------|
| Mutable borrow conflicts with `&mut self.agents` during concurrent access | Extract query logic into standalone async functions that take owned/cloned data; write results back after join |
| Increased concurrent connections to agents | Bounded by fleet size (typically 2-5); no throttling needed |
