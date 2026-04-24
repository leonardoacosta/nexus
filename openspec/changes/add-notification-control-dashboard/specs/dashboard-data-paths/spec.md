# dashboard-data-paths — Spec Delta

## ADDED Requirements

### Requirement: /notifications page MUST render table + settings strip

A new route at `/notifications` in `apps/nextjs` MUST render a single scrollable page with two components:
- A settings strip at the top containing three controls (TTS switch, Banners switch, Ducking radio group `full`/`half`/`mute`)
- A notifications table below showing recent delivered/queued/failed notifications sorted by `created_at` descending, capped at 50 rows on initial load with pagination for older rows

The page MUST be server-rendered (async server component) for the initial payload, then hydrated with a client component that maintains live state via SSE.

#### Scenario: Initial page load shows seeded settings + recent notifications

- **GIVEN** the user navigates to `http://homelab:3100/notifications`
- **WHEN** the server component mounts
- **THEN** it fetches `GET /notifications/settings` and `GET /notifications?limit=50` concurrently
- **AND** the rendered HTML contains the three controls reflecting current settings
- **AND** the table contains up to 50 most-recent rows

#### Scenario: SSE live updates prepend new rows

- **GIVEN** the user has the `/notifications` page open
- **WHEN** a new notification fires elsewhere (CC hook, manual POST, replay)
- **THEN** the client component receives the `NotificationFired` SSE frame
- **AND** prepends a new row to the top of the table within 2 seconds
- **AND** no full refetch occurs

### Requirement: Toggle controls MUST PATCH settings with optimistic UI

Each toggle (TTS switch, Banners switch, Ducking radio) MUST call `PATCH /notifications/settings` with the mutated field. The UI MUST update optimistically before the network request completes. On non-2xx response, the UI MUST roll back the optimistic state and surface a non-blocking toast indicating the failure.

#### Scenario: Successful toggle

- **GIVEN** TTS is currently on
- **WHEN** the user clicks the TTS switch to off
- **THEN** the switch UI immediately reflects "off"
- **AND** a PATCH `/notifications/settings` with `{"tts_enabled": false}` is sent
- **AND** on 200 response, the UI remains in "off" state (no visual flicker)

#### Scenario: Failed toggle rolls back

- **GIVEN** TTS is currently on
- **AND** the user clicks the switch to off
- **AND** the PATCH request returns 500
- **THEN** the switch UI reverts to "on"
- **AND** a toast appears: "Failed to update settings"
- **AND** the toast auto-dismisses within 5 seconds

### Requirement: Replay button MUST duplicate the notification

The replay button (`▶`) at the end of each row MUST POST a new notification to `/notifications/send` with:
- `id`: freshly generated (not the original)
- `title`: same as source row
- `body`: same as source row
- `channel`: same as source row
- `project`: same as source row

A replayed notification creates a new DB row, fires through the normal pipeline, and appears at the top of the table via SSE on success. The replay button MUST be disabled for rows with status `suppressed` or `expired` (no visual replay sense).

#### Scenario: Replay creates new notification

- **GIVEN** a row in the table with status `delivered`, title "Test", body "hello"
- **WHEN** the user clicks `▶`
- **THEN** a POST `/notifications/send` fires with a new id and same body/title/channel/project
- **AND** the new notification appears at the top of the table
- **AND** the source row is unchanged

#### Scenario: Replay disabled for expired rows

- **GIVEN** a row with status `expired`
- **WHEN** the user attempts to click `▶`
- **THEN** the button is disabled (not clickable)

### Requirement: Settings strip MUST be non-intrusive

The settings strip MUST occupy ≤ 120px vertical height, MUST NOT use modals or full-page takeovers for any interaction, and MUST NOT play audio previews on ducking-mode changes (preview would require ElevenLabs spend and audibly disrupt the user). Toggle interactions MUST debounce at ≥ 250ms to avoid thrashing the PATCH endpoint under rapid switching.

#### Scenario: Strip height constraint

- **WHEN** the page is rendered at any viewport width
- **THEN** the settings strip container has `max-height: 120px`

#### Scenario: No preview on ducking change

- **GIVEN** the user is on the page
- **WHEN** they change Ducking from `full` to `half`
- **THEN** no audio plays
- **AND** the change applies to the NEXT real TTS notification only
