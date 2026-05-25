<!-- beads:epic:nx-rxlbi -->
<!-- beads:feature:nx-e3f6p -->

# Tasks: agent-swift-readmodel-fields

## DB Batch

## API Batch

- [x] [1.1] Add `trace_id` + `stack_truncated` to the ScriptError shape on `GET /failures` (agent) and the core type [owner:api-engineer] [type:api] [beads:nx-gkr9e]
- [x] [1.2] Add `severity` + delivery-state to NotificationEvent on `GET /notifications` (agent) and the core type [owner:api-engineer] [type:api] [beads:nx-uqwci]
- [x] [1.3] Add `hasProposal`/`hasDesign`/`hasTasks` tri-state to SpecSummary on `GET /specs` (agent) and the core type [owner:api-engineer] [type:api] [beads:nx-wfkfz]
- [x] [1.4] Add `hidden` to ProjectAggregate on `GET /projects` (agent) and the core type [owner:api-engineer] [type:api] [beads:nx-shncp]

## UI Batch

- [x] [2.1] Mirror all four field additions into the NexusShared Swift models + Codable decoding so the clients consume them [owner:ui-engineer] [type:ui]

## E2E Batch
