## REMOVED Requirements

### Requirement: peer-federation WebSocket endpoint

**Reason for removal**: The spine architecture (per `docs/nexus-evolution.html`) makes homelab the exclusive nexus-agent. No peer agents exist to federate with. Removing peer-federation eliminates ~600 LOC including echo suppression, per-peer ring buffers, and exponential backoff reconnect logic.

**Migration**: clients no longer need to handle `source: 'peer' | 'local'` envelope tags — all envelopes are implicitly local. `agents.toml` becomes client-discovery only.

#### Scenario: /ws/federation returns 404
- **GIVEN** the removal is complete
- **WHEN** a client attempts `wscat -c ws://localhost:7400/ws/federation`
- **THEN** the connection is rejected with 404

#### Scenario: lifecycle envelope has no source tag
- **GIVEN** the removal is complete
- **WHEN** any envelope is inspected (via SSE or other consumer)
- **THEN** it has no `source` field (the discriminator is gone)
