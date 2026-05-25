# swift-menubar-client

## ADDED Requirements

### Requirement: Read-model endpoints expose UI-required fields

Each of the four agent read-model endpoints SHALL serialize the additional fields its client needs, and the matching `packages/core` type MUST declare them so the contract is enforced at compile time.

- `GET /failures` SHALL include `trace_id` and `stack_truncated` on every `ScriptError` entry.
- `GET /notifications` SHALL include `severity` and a delivery-state field on every `NotificationEvent` entry.
- `GET /specs` SHALL include `hasProposal`, `hasDesign`, and `hasTasks` as a tri-state on every `SpecSummary` entry.
- `GET /projects` SHALL include `hidden` on every `ProjectAggregate` entry.

#### Scenario: Failures endpoint returns trace correlation fields

- **WHEN** a client requests `GET /failures` and at least one `ScriptError` is stored
- **THEN** each entry SHALL contain a `trace_id` string and a `stack_truncated` boolean
- **AND** the `packages/core` `ScriptError` type SHALL declare both fields so the JSON matches the contract

#### Scenario: Specs endpoint reports artifact tri-state

- **WHEN** a client requests `GET /specs`
- **THEN** each `SpecSummary` SHALL report `hasProposal`, `hasDesign`, and `hasTasks` reflecting whether each artifact exists for that spec
- **AND** the `packages/core` `SpecSummary` type SHALL declare the three fields

### Requirement: NexusShared Swift models decode the new fields

The NexusShared Swift models for the four read-model shapes MUST add the matching properties and Codable decoding so the dashboard, iOS, and watch clients consume the new fields without decode errors.

#### Scenario: Swift models decode extended JSON

- **WHEN** a NexusShared client decodes JSON from any of the four extended endpoints
- **THEN** the corresponding Swift model (`ScriptError`, `Notification`, `SpecSummary`, `ProjectAggregate`) SHALL expose the new properties populated from the payload
- **AND** decoding SHALL succeed for both payloads that include the new fields and legacy payloads that omit them
