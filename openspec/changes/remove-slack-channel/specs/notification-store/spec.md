## REMOVED Requirements

### Requirement: Slack webhook channel dispatcher

**Reason for removal**: Per the spine-migration scope, Slack is no longer part of the notification dispatch matrix. The Swift app + macOS UNNotificationCenter handle all user-facing notification surfaces.

**Migration**: callers that previously passed `channel: ['slack']` will see those routes silently dropped (with a `script_errors` log entry after P2.4 `enforce-pino-script-errors`). Other channels in the same call continue to route.

#### Scenario: slack-only notification is dropped with a warning
- **GIVEN** the slack channel is removed
- **WHEN** `POST /notifications/send {channel: ['slack'], title: '...', body: '...'}`
- **THEN** response is `200 { dispatched: [] }` and one `script_errors` row is written at WARN level

#### Scenario: mixed-channel notification routes the survivors
- **GIVEN** the slack channel is removed
- **WHEN** `POST /notifications/send {channel: ['slack', 'tts'], ...}`
- **THEN** TTS dispatches normally and slack is dropped with a warning log
