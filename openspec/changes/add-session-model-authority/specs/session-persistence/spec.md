## ADDED Requirements

### Requirement: Session model capture

The agent SHALL populate each session's `model` field from the live CC hook payload rather than
leave it at its managed-spawn placeholder, and SHALL keep it current across mid-session model
switches rather than capturing it only once at session start.

#### Scenario: Model captured on session start

- **WHEN** the agent receives a `session_start` hook event whose payload carries a non-empty
  `model` value
- **THEN** the session's `model` field SHALL be set to that value

#### Scenario: Model refreshed on a later heartbeat

- **WHEN** the agent receives a `session_heartbeat` hook event for an existing session whose
  payload carries a `model` value different from the session's current stored value
- **THEN** the session's `model` field SHALL be updated to the new value (last-write-wins)

#### Scenario: Missing model value does not clobber existing data

- **WHEN** a hook event's payload has no `model` field, or an empty one
- **THEN** the session's existing `model` value SHALL be left unchanged

### Requirement: GET /statusline surfaces a live model letter

`GET /statusline` SHALL derive each session's `model` field in its response from the session
row's stored (raw) model value via the shared single-letter family mapping, rather than the
literal `null` it returns today regardless of what the row holds.

#### Scenario: Session with a captured model returns its letter

- **GIVEN** a session row whose `model` column holds `"claude-opus-4-8"`
- **WHEN** a client requests `GET /statusline`
- **THEN** that session's entry in the response has `model: "O"`

#### Scenario: Session with no captured model returns null

- **GIVEN** a session row whose `model` column is `null` or empty
- **WHEN** a client requests `GET /statusline`
- **THEN** that session's entry in the response has `model: null`

### Requirement: Model family letter mapping is a single shared implementation

The system SHALL define the model-id/display-name to single-letter family mapping (fable,
opus, sonnet, haiku mapping to F, O, S, H respectively; an unknown family falling back to the
uppercased display-name initial; no model producing null) in exactly one shared location,
`packages/core`, consumed by both the agent's server-side derivation and any client-side
renderer, rather than duplicated per consumer.

#### Scenario: Agent and statusline renderer agree on the same letter

- **GIVEN** a model value `"claude-sonnet-5"`
- **WHEN** both `GET /statusline`'s server-side derivation and `apps/nexus-statusline`'s
  client-side renderer compute a family letter for it
- **THEN** both SHALL produce `"S"` via the same shared `packages/core` function, not two
  independently-maintained implementations
