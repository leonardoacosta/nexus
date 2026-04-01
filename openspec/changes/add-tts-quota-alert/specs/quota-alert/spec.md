# Spec: TTS Quota Exhaustion Alert

## ADDED Requirements

### Requirement: First-failure desktop alert
When ElevenLabs TTS fails for the first time in an agent session, a desktop notification is sent informing the user that TTS has fallen back to system voice.

#### Scenario: Quota exhausted triggers alert
Given ElevenLabs has not failed in this agent session
And the API returns 401 with "quota_exceeded"
When `process_speak_request` handles the error
Then a desktop notification is sent: "ElevenLabs quota exhausted — using system TTS. Top up credits to restore voice."
And the original notification is still delivered via system TTS

#### Scenario: Second failure is silent
Given ElevenLabs already failed once in this session (alert was sent)
And the API returns another error
When `process_speak_request` handles the error
Then NO additional desktop alert is sent
And the notification is delivered via system TTS as normal

#### Scenario: Agent restart resets dedup
Given the agent was restarted after an ElevenLabs failure
And the API key is still expired
When the first notification triggers ElevenLabs
Then a new alert is sent (dedup flag was reset by restart)

### Requirement: Error context in alert message
The alert includes the specific failure reason from the ElevenLabs API response.

#### Scenario: Quota error message
Given ElevenLabs returns `{"detail":{"status":"quota_exceeded","message":"..."}}`
When the alert is constructed
Then the notification body includes "quota exhausted"

#### Scenario: Auth error message
Given ElevenLabs returns 401 with "invalid_api_key"
When the alert is constructed
Then the notification body includes "invalid API key"

#### Scenario: Network error message
Given the ElevenLabs API call times out
When the alert is constructed
Then the notification body includes "connection failed"
