---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Remove peer-connector service

## Change ID
`remove-peer-connector`

## Phase
P1 consolidation (parent: spine-migration · nx-ma6h8 · feature: nx-iyh3t)

## Summary
Delete `apps/agent/src/services/peer-connector.ts` and all WebSocket federation logic — no peer agents exist in the spine model.

## Context
- Deletes: `apps/agent/src/services/peer-connector.ts` (~600 LOC)
- Modifies: `apps/agent/src/lifecycle-bus.ts` (drop `source: 'peer' | 'local'` tagging)
- Modifies: `apps/agent/src/index.ts` (drop peer-connector initialization)
- Modifies: `apps/agent/src/server-websocket.ts` (remove `/ws/federation` route)
- Configuration: `~/.config/nexus/agents.toml` becomes irrelevant for federation (still used for client discovery)

## Motivation
Spine model: homelab is the only nexus-agent. No peer agents to federate with. Removes ~600 LOC including echo suppression, per-peer 1000-event ring buffer, exponential backoff reconnect (1s → 30s). Simplifies the lifecycle envelope (no more `source` tag distinguishing local vs peer).

## Requirements

### Requirement: /ws/federation endpoint MUST NOT exist

After this change, the agent's HTTP server SHALL NOT respond to WebSocket upgrades on `/ws/federation`. Clients attempting to connect SHALL receive a 404.

### Requirement: lifecycle envelope source field is dropped

The `LifecycleEnvelope` type SHALL no longer carry a `source: 'local' | 'peer'` discriminator. All envelopes are implicitly local.

#### Scenario: agent boots without peer-connector
- **GIVEN** the deletion is complete
- **WHEN** `nexus-agent` starts
- **THEN** zero log messages reference peers, federation, or echo suppression
