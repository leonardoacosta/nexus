# Integration Registry

## ADDED Requirements

### Requirement: Endpoint-URL provider metadata MUST reject loopback and link-local hosts

Provider metadata carrying a user-supplied endpoint URL (kokoro `baseUrl`, and any future `requiresSecret: false` endpoint provider) SHALL only accept `http`/`https` schemes and SHALL reject literal loopback (`localhost`, `127.0.0.0/8`, `::1`) and link-local (`169.254.0.0/16`, `fe80::/10`) hosts, at schema-validation time AND as a pre-fetch guard for rows persisted before validation existed. RFC1918 and tailnet (100.64/10) hosts remain allowed — self-hosted deployments are the feature's purpose. DNS-rebinding is an accepted, documented limitation (tailnet-only exposure).

#### Scenario: Loopback baseUrl rejected at persist

- **WHEN** a PATCH sets kokoro `baseUrl` to a loopback or link-local host
- **THEN** the metadata schema rejects it with a 400

#### Scenario: Pre-existing forbidden row never fetched

- **WHEN** a row persisted before this validation carries a forbidden `baseUrl` and a test/voices probe runs
- **THEN** the probe returns not-ok without issuing any HTTP request

#### Scenario: Private-network deployment still works

- **WHEN** `baseUrl` names an RFC1918 or tailnet host over http/https
- **THEN** validation passes and probes fetch normally
