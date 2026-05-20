# test-infrastructure Specification Delta

## ADDED Requirements

### Requirement: Project Aggregate Includes Hidden Field

The agent's `GET /projects` response SHALL include a top-level `hidden` boolean
field on every row. The Swift `ProjectAggregate` model MUST decode this field
as a non-optional `Bool` with default `false` for backward compatibility with
older agents emitting an absent field.

#### Scenario: registry rows surface hidden state

- **GIVEN** a project in the registry with `hidden = true`
- **WHEN** the dashboard fetches `GET /projects`
- **THEN** the response row for that project contains `"hidden": true`
- **AND** the Swift `ProjectAggregate.hidden` decodes to `true`

#### Scenario: unregistered bucket defaults to false

- **GIVEN** the synthetic `(unregistered)` bucket aggregating session-only projects
- **WHEN** the dashboard fetches `GET /projects`
- **THEN** the bucket row has `"hidden": false`

#### Scenario: older agent absent field tolerated

- **WHEN** an older agent (pre-payload-completeness) omits the field
- **THEN** the Swift decoder substitutes `false` and the dashboard does not
  throw a decode error
- **AND** the per-push gate's PayloadDecodeTests v2 fixture pins the new
  required emission against current-generation agents only

### Requirement: Spec Watcher Emits Marker Tri-State

The agent's `GET /specs` response SHALL include `has_proposal`,
`has_design`, and `has_tasks` boolean fields on every row, derived from
filesystem presence of `proposal.md`, `design.md`, and `tasks.md` in the
spec directory at scan time. The Swift `SpecSummary` model MUST decode all
three as non-optional `Bool`.

#### Scenario: complete spec reports true for all three

- **GIVEN** a spec directory containing `proposal.md`, `design.md`, `tasks.md`
- **WHEN** the spec-watcher emits a row for that spec
- **THEN** `has_proposal = true`, `has_design = true`, `has_tasks = true`

#### Scenario: proposal-only spec reports tri-state

- **GIVEN** a spec directory with only `proposal.md` (no design.md, no tasks.md)
- **WHEN** the spec-watcher emits the row
- **THEN** `has_proposal = true`, `has_design = false`, `has_tasks = false`

#### Scenario: PayloadDecodeTests v2 pins all three fields

- **WHEN** the agent JSON for a spec omits any of the three marker fields
- **AND** the developer runs `git push`
- **THEN** the pre-push gate's `PayloadDecodeTests` decode fails
- **AND** the push is aborted

### Requirement: Notification List Endpoint Exists

The agent SHALL expose `GET /notifications` returning an array of
`NotificationEvent` rows. Each row MUST include `severity` (one of `info`,
`warn`, `error`) and `delivery_state` (one of `pending`, `delivered`,
`failed`) fields. The Swift `NotificationEvent` model MUST decode both as
non-optional enum cases.

#### Scenario: empty list returns 200 with empty array

- **WHEN** the agent has no notifications recorded
- **THEN** `GET /notifications` returns 200 with body `[]`
- **AND** the Swift dashboard's notifications view renders an empty state

#### Scenario: populated list decodes severity + delivery_state

- **GIVEN** the agent has at least one notification with `severity: "warn"`
  and `delivery_state: "delivered"`
- **WHEN** the dashboard fetches `GET /notifications`
- **THEN** the response contains the row with the matching field values
- **AND** the Swift decoder produces `NotificationEvent.severity == .warn`
  and `.deliveryState == .delivered`

#### Scenario: unknown severity fails the gate

- **WHEN** an agent emits a severity outside the documented enum (e.g.
  `"critical"`)
- **THEN** the PayloadDecodeTests v2 fixture decode fails
- **AND** the push is aborted with the unknown enum value in the failure
  message

### Requirement: Failure Top Errors Include Trace ID + Stack Truncation Marker

The agent's `GET /failures.top_errors[]` rows SHALL each include a `trace_id`
string field (nullable on legacy pre-instrumentation rows) and a
`stack_truncated` boolean. The Swift `ScriptError` model MUST decode
`trace_id` as `String?` and `stack_truncated` as non-optional `Bool` with
default `false` for older agents.

#### Scenario: instrumented error carries trace_id

- **GIVEN** a recent failure logged with OpenTelemetry instrumentation
- **WHEN** the failures aggregate is fetched
- **THEN** the corresponding `top_errors` row has a non-null `trace_id`

#### Scenario: legacy row has null trace_id

- **GIVEN** a pre-instrumentation row in `script_errors`
- **WHEN** the aggregate is fetched
- **THEN** the row's `trace_id` is `null`
- **AND** the Swift decoder produces `ScriptError.traceID == nil` without
  throwing

#### Scenario: long stack flagged as truncated

- **GIVEN** an error whose serialized stack exceeds the agent's truncation
  threshold
- **WHEN** the agent emits the row
- **THEN** `stack_truncated = true`
- **AND** the `stack` field contains the truncated content

### Requirement: PayloadDecodeTests v2 Enforces Required Fields

The Swift `NexusSharedTests/PayloadDecodeTests` SHALL replace
`decodeIfPresent` patterns with non-optional Codable for the four
newly-required field groups: `ProjectAggregate.hidden`,
`SpecSummary.{hasProposal, hasDesign, hasTasks}`,
`NotificationEvent.{severity, deliveryState}`, and
`ScriptError.stackTruncated`. A canonical JSON fixture per endpoint MUST be
maintained inline and updated whenever the agent's emission shape changes.

#### Scenario: missing required field aborts the gate

- **WHEN** an agent regression drops any one of the new required fields
- **AND** the developer runs `git push`
- **THEN** the pre-push gate's Tier A xcodebuild invocation returns non-zero
- **AND** the failure tail contains the specific Codable key that was missing
- **AND** the push is aborted

#### Scenario: legacy nullable fields tolerated

- **WHEN** the agent emits `trace_id: null` on a legacy row
- **THEN** the Swift decoder produces `nil` for `traceID` WITHOUT failing
- **AND** the test passes
- **AND** the gate proceeds
