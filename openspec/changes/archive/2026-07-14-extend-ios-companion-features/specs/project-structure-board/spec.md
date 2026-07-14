## ADDED Requirements

### Requirement: Board-to-iOS-nav adoption SHALL be assessed via a documented spike

A design note SHALL be produced assessing how the project-structure board (rail selector w/
All, proposal rows, orphan beads, detail rail) maps onto nexus-ios Scenes navigation, ending in
an explicit go/no-go recommendation, before any iOS board implementation work is scheduled.
`NexusShared` already carries the all-variant client methods and optional project/description
decode this spike needs, so the spike is UI-shape assessment only — no new client wiring.

#### Scenario: Spike deliverable exists with an explicit go/no-go call

- **GIVEN** the spike is complete
- **WHEN** its output document is reviewed
- **THEN** it contains a UI-shape mapping of the board's rail selector / proposal rows / orphan
  beads / detail rail onto nexus-ios Scenes navigation primitives
- **AND** it ends with an explicit go or no-go recommendation, not an open-ended discussion
