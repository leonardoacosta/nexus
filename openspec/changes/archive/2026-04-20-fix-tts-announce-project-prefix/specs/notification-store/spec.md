# notification-store — Spec Delta

## ADDED Requirements

### Requirement: TTS channel renders project prefix

The TTS notification channel MUST prepend the originating project identifier to the synthesized speech text when the notification carries a non-empty `project` field. The prefix format MUST be `"<project>: "` (project slug, colon, single space). When the `project` field is `null`, `undefined`, or an empty string, the channel MUST render only the bare body with no prefix, no placeholder project name, and no attribution to the receiver host (e.g. `"nexus"`). Both the live ElevenLabs POST path and the offline stub (no `ELEVENLABS_API_KEY`) MUST apply the same composition so the logged text matches the spoken text.

#### Scenario: Notification with project prepends prefix

- **GIVEN** `ELEVENLABS_API_KEY` is set
- **AND** a notification with `project: "nova"` and `body: "build complete"` is queued
- **WHEN** the TTS channel sends the notification
- **THEN** the request body sent to `https://api.elevenlabs.io/v1/text-to-speech/<voiceId>` contains `text: "nova: build complete"`

#### Scenario: Notification with null project announces bare body

- **GIVEN** `ELEVENLABS_API_KEY` is set
- **AND** a notification with `project: null` and `body: "deploy succeeded"` is queued
- **WHEN** the TTS channel sends the notification
- **THEN** the request body contains `text: "deploy succeeded"` with no prefix, no colon, and no substituted project name

#### Scenario: Empty string project treated as absent

- **GIVEN** a notification with `project: ""` (empty string)
- **WHEN** the TTS channel renders the text
- **THEN** the composed text is the bare body, identical to the null-project case

#### Scenario: Stub path renders identical text when API key unset

- **GIVEN** `ELEVENLABS_API_KEY` is not set
- **AND** a notification with `project: "nx"` and `body: "tests green"` is queued
- **WHEN** the TTS channel falls through to the console stub
- **THEN** the logged `body` field reflects the composed `"nx: tests green"` so the stub is observably equivalent to the live path

### Requirement: Notification socket payload carries project field

The socket event of type `notification` MUST accept an optional `project?: string` field carrying the originating project slug. The dispatcher MUST pass this value unmodified onto the `NotificationRow.project` field and MUST NOT substitute a default such as `"nexus"` when the field is absent. The payload schema documentation MUST describe the field's intent and include at least one example of how external senders should populate it (e.g. `basename "$PWD"`).

#### Scenario: Dispatcher preserves project from payload

- **GIVEN** a socket event `{ event: "notification", message: "X", project: "nova" }` arrives on `/tmp/nexus-agent.sock`
- **WHEN** the dispatcher routes to the TTS channel
- **THEN** the `NotificationRow` passed to `sendTtsNotification` has `project === "nova"`

#### Scenario: Missing project field flows through as null

- **GIVEN** a socket event `{ event: "notification", message: "X" }` with no `project` field arrives
- **WHEN** the dispatcher constructs the `NotificationRow`
- **THEN** `NotificationRow.project` is `null`
- **AND** no default project string (e.g. `"nexus"`, `"unknown"`) is substituted

#### Scenario: Schema documentation names the project field

- **GIVEN** a developer inspecting the socket event types for the `notification` variant
- **WHEN** they read the TSDoc on the event schema
- **THEN** the `project` field is documented with purpose, nullability, and at least one example of how to populate it from a sending context
