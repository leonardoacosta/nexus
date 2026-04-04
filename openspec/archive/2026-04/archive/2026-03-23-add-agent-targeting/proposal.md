# Change: Add Agent Targeting for Session Operations

## Why
Currently `StartSession` accepts a project code and Nexus tries each agent sequentially.
External consumers like Nova need to explicitly target a specific agent (e.g., "start on homelab,
not macbook") for workload placement and to avoid routing sessions to the wrong machine.

## What Changes
- Add optional `agent_name` field to `StartSessionRequest` proto
- When provided, only the named agent is tried; when absent, existing round-robin behavior preserved
- Add `ListAgents` RPC to expose which agents are configured (for discovery)

## Impact
- Affected specs: `session-management` (new capability spec)
- Affected code: `proto/nexus.proto`, `crates/nexus-agent/src/grpc.rs`
- Non-breaking: new optional field, existing callers unaffected
