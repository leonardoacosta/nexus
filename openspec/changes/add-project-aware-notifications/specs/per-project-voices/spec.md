# Spec: Per-Project Voice Configuration

## MODIFIED Requirements

### Requirement: Voice resolution uses same project lookup
The per-project voice resolution MUST share the same project code normalization as display name
resolution, ensuring consistent behavior across channels.

#### Scenario: Project with custom voice
Given `notifications.json` maps `projectVoices.tl` to voice ID `"IKne3meq5aSn9XLyUdCD"`
When a TTS notification is synthesized for project `"tl"`
Then ElevenLabs uses voice `"IKne3meq5aSn9XLyUdCD"`.

#### Scenario: Project without custom voice
Given `notifications.json` has no entry in `projectVoices` for project `"mv"`
When a TTS notification is synthesized for project `"mv"`
Then ElevenLabs uses the default voice from `elevenlabs.voiceId`.

---

### Requirement: Example config documents voice mapping
The example notification config MUST document the `projectVoices` mapping format.

#### Scenario: Example config is complete
Given the example config at `config/notifications.example.toml`
When a user reads it for setup guidance
Then it contains a `[project_voices]` section with example mappings and a comment explaining
the fallback chain (project-specific -> "default" key -> elevenlabs.voice_id).
