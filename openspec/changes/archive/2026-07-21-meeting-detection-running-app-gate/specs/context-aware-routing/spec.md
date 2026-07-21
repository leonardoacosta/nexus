# Context-Aware Notification Routing

## MODIFIED Requirements

### Requirement: Meeting Detection via Camera and Mic

The sensor SHALL detect a meeting using `(camera OR mic) IS-RUNNING-SOMEWHERE AND a known
meeting app is RUNNING (present in the list of currently-running applications)`, AND-gated so
camera-alone (Photo Booth, Continuity Camera) does not trigger a hold (decision Q2). The meeting
app is no longer required to be frontmost — it need only be open. When detected it SHALL set
`inMeeting` true in the reported vector.

#### Scenario: Video call sets inMeeting

- **WHEN** the camera is in use AND a known meeting app is running
- **THEN** the sensor reports `inMeeting: true`

#### Scenario: Meeting continues after focus moves away

- **WHEN** the camera or mic is in use, a known meeting app is running, but the frontmost app is
  something else (e.g. a terminal or editor)
- **THEN** the sensor still reports `inMeeting: true`

#### Scenario: Camera-alone does not trigger a meeting

- **WHEN** the camera is in use but no meeting app is running (e.g. Photo Booth)
- **THEN** the sensor does NOT report `inMeeting: true`

#### Scenario: Meeting app open but idle does not trigger a meeting

- **WHEN** a known meeting app is running but neither the camera nor the mic is in use
- **THEN** the sensor does NOT report `inMeeting: true`

#### Scenario: Meeting ends when the app quits or devices go idle

- **WHEN** the meeting app is no longer running, or both the camera and mic stop being in use
- **THEN** the sensor reports `inMeeting: false` on the next delta
