# swift-menubar-client Delta

## ADDED Requirements

### Requirement: notifications-sort-and-group
The Notifications tab MUST expose a sort-mode picker in its header with three options: `Time ↓` (default, descending by `receivedAt`), `Project ↑` (ascending by project slug then descending time within group), `Session ↑` (ascending by session id then descending time). The chosen mode MUST persist via `@AppStorage("notifications.sort")`. When sort is Project or Session, an optional "Group" toggle MUST collapse rows into accordion sections by group key. Rows with nil project or session MUST aggregate into a "Misc" group rendered last.

#### Scenario: time-desc default
- **Given** the Notifications tab is opened fresh (no @AppStorage entry)
- **When** the tab renders
- **Then** the picker is on `Time ↓`; rows are ordered newest-first by `receivedAt`

#### Scenario: project sort with group toggle
- **Given** the user picks `Project ↑` and enables "Group"
- **When** rows render
- **Then** rows collapse into accordion sections — one per project slug, sorted ascending; "Misc" (nil project) appears last; within each section rows are sorted newest-first

#### Scenario: persistence across launches
- **Given** the user picked `Session ↑` last session
- **When** the app relaunches
- **Then** the picker is restored to `Session ↑`

### Requirement: notification-replay-button
Each notification row MUST display a `▶︎` replay button when the row's `audioAvailable == true`. Tapping the button MUST stream `GET /notifications/:id/audio` into the shared `MP3Player` actor. While playback is in flight, the button MUST show a stop affordance; a second tap stops playback. While streaming, an in-flight network request MUST cancel cleanly if the user changes tabs or clicks another row's button.

#### Scenario: replay populated row
- **Given** a notification row with `audioAvailable == true`
- **When** the user taps the replay button
- **Then** `GET /notifications/<id>/audio` is fetched as a stream and piped to `MP3Player.play`; the button switches to a stop icon during playback

#### Scenario: button hidden for no-audio rows
- **Given** a notification row with `audioAvailable == false`
- **When** the row renders
- **Then** no replay button is present (the affordance is omitted entirely)

#### Scenario: cancel-on-tab-change
- **Given** the user tapped replay and the audio is streaming
- **When** the user switches to the Sessions tab
- **Then** the URLSession task is cancelled; `MP3Player` stops; no leaked task remains

### Requirement: elevenlabs-status-chip
The Notifications tab header MUST mount an `ElevenLabsStatusChip` showing the current key state: `key set` (green dot), `no key` (orange dot, "Paste key →"), `key invalid` (red dot, "Re-paste key →"). Tapping the chip MUST open a popover with: a masked-show of the current key (button to reveal/hide), a paste field for replacement, a Test button that triggers `ElevenLabsClient.synthesize` with the global voice, and a Save button that writes to Keychain.

#### Scenario: no key on first launch
- **Given** Keychain has no `elevenLabsApiKey`
- **When** the Notifications tab renders
- **Then** the chip shows orange dot + "Paste key →" tooltip

#### Scenario: key paste + test + save
- **Given** chip popover is open with a pasted key
- **When** the user taps Test and the synthesis succeeds (200 with mp3 bytes)
- **Then** the Test button shows a green checkmark for 2s; Save is enabled; tapping Save writes the key to Keychain and the chip transitions to green

#### Scenario: invalid key surfaces
- **Given** Keychain has a key but a recent synth call returned 401
- **When** the chip renders
- **Then** the chip shows red dot + "Re-paste key →" — the observer sets this via a shared `@Published` state

### Requirement: project-voices-editor
The Settings tab MUST gain a `ProjectVoicesView` section listing every project that has a voice override, plus an "Add project" affordance. Each row MUST contain the project slug (read-only after creation), a voice id text field, a Test button (synth a sample with this voice), and a delete icon. Save MUST `PUT /notifications/voices/:project`; delete MUST `DELETE /notifications/voices/:project`. Local state MUST optimistically reflect changes and reconcile against the server response.

#### Scenario: add project voice
- **Given** the editor is open, no overrides exist
- **When** the user clicks "Add project", enters `nx`, enters voice id `voice-XYZ`, taps Save
- **Then** `PUT /notifications/voices/nx { voice_id: "voice-XYZ" }` is called; on 200 the row persists in the editor

#### Scenario: test voice before save
- **Given** a project row with a voice id entered but not yet saved
- **When** the user taps Test
- **Then** `ElevenLabsClient.synthesize(text: "Test", voiceId: <entered>)` runs; on success the Test button shows a green checkmark

#### Scenario: delete row
- **Given** a row for `nx` is saved
- **When** the user clicks the delete icon
- **Then** the row is removed from the editor; `DELETE /notifications/voices/nx` fires; on 204 no further action; on error the row is restored and a banner shows
