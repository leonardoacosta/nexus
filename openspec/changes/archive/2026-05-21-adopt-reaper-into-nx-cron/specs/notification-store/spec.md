## ADDED Requirements

### Requirement: NotificationFired payload MUST carry structured items and a log path

The `NotificationFired` lifecycle payload MUST be extended with an optional
`items` string array (a bullet list of findings) and an optional `logPath`
(an absolute filesystem path to the originating run log). The Swift
`NotificationEvent` mirror in NexusShared MUST be extended with the same two
optional fields so the cross-platform shape stays in sync. Both fields MUST
be optional and back-compatible: existing emitters that omit them MUST
continue to render exactly as before.

#### Scenario: Reaper completion carries items and logPath

- **WHEN** the reaper job emits its completion notification
- **THEN** the `NotificationFired` payload includes `items` (the per-finding
  bullet lines) and `logPath` (the absolute path to the reaper run log)

#### Scenario: Legacy emitter omits the new fields

- **GIVEN** an existing notification emitter that sets only `title` and
  `body`
- **WHEN** it emits `NotificationFired`
- **THEN** `items` and `logPath` are absent and the notification renders
  identically to its pre-change behavior

### Requirement: The notification renderer MUST render items as a bullet list

The Mac listener notification renderer MUST render a non-empty `items` array
as a bullet list in the delivered notification rather than concatenating the
findings into a single banner line.

#### Scenario: Findings rendered as bullets

- **GIVEN** a `NotificationFired` payload whose `items` contains three
  findings
- **WHEN** the Mac listener renders the notification
- **THEN** the three findings are presented as a bullet list, not as one
  run-on banner line

### Requirement: Clicking a notification with a logPath MUST open the run log

The renderer MUST open the referenced log file via the OS default handler
when a delivered notification carries a `logPath` and the user activates it.
This replaces the current raw-`osascript` banner whose click attribution
incorrectly opened the scripts folder; the fix SHALL live in the renderer so
all nx notifications that supply a `logPath` benefit.

#### Scenario: Click opens the run log

- **GIVEN** a delivered notification with `logPath` set to an existing file
- **WHEN** the user clicks/activates the notification
- **THEN** the OS opens that log file (not the scripts folder, not the app)

#### Scenario: No logPath falls back to default activation

- **GIVEN** a delivered notification with no `logPath`
- **WHEN** the user clicks/activates it
- **THEN** the renderer performs its default activation behavior and does not
  error

### Requirement: Bloat warnings MUST retain a dedicated spoken TTS

A bloat-radar warning MUST be delivered as a dedicated spoken TTS message,
separate from the routine completion summary, so it is not lost in the
digest.

#### Scenario: Dedicated bloat TTS spoken

- **GIVEN** the reaper run produced one or more bloat findings
- **WHEN** the completion notifications are dispatched
- **THEN** a dedicated TTS message announcing the bloat warning is spoken in
  addition to the routine completion summary and its bullet-list desktop
  notification
