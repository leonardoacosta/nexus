# Proposal: Project-Aware Notifications

## Change ID
`add-project-aware-notifications`

## Summary
Replace generic "Claude" / uppercase project codes in notification titles with emoji-prefixed
display names (e.g., "🎯 Otaku Odyssey") across all three notification channels (banner, APNs,
TTS), and document the existing per-project ElevenLabs voice configuration.

## Context
- Extends: `crates/nexus-agent/src/services/receiver/delivery.rs` (banner + APNs title),
  `crates/nexus-agent/src/notification_engine.rs` (TTS prefix),
  `crates/nexus-agent/src/claude_utils/project.rs` (project loader)
- Related: `~/.claude/scripts/config/projects.json` (project registry with display names + emoji),
  `~/.claude/scripts/notifications/config/notifications.json` (per-project voice config)
- Bug: `project.rs` read from wrong path (`state/projects.json` vs `config/projects.json`)

## Motivation
All notifications currently show "Claude" as the title (or an uppercase 2-letter code like "OO").
With 14+ active projects running concurrent Claude sessions, it's impossible to identify which
project a notification belongs to from the notification center. Display names + emoji icons provide
instant visual identification. Per-project voices add auditory differentiation for TTS.

## Requirements

### Req-1: Fix project registry path
Fix the path bug in `project.rs` so `get_projects()` actually loads `projects.json` from
`~/.claude/scripts/config/` instead of the nonexistent `~/.claude/scripts/state/` path.

### Req-2: Display names in notification titles
All three notification channels must resolve project codes to display names:
- **Banner** (terminal-notifier): title becomes `"{icon} {name}"` (e.g., "🎯 Otaku Odyssey")
- **APNs** (Watch): title becomes `"{icon} {name}"`
- **TTS** (ElevenLabs): spoken prefix becomes `"{name} —"` (no emoji in speech)

### Req-3: Fallback for unknown projects
When the project code is empty, "global", or not found in `projects.json`:
- Banner/APNs title: `"🔭 Nexus"`
- TTS prefix: `"Nexus —"`

### Req-4: Document per-project voice configuration
The `projectVoices` map in `notifications.json` already supports per-project ElevenLabs voice IDs.
Document this in the example config and ensure the voice lookup integrates with the display name
lookup (same project resolution path).

## Scope
- **IN**: Path fix, display name resolution in banner/APNs/TTS, fallback handling, config docs
- **OUT**: Custom app icons via terminal-notifier (future — requires PNG assets from svgl.app),
  auto-assignment of voices, TUI changes, new voice selection UI

## Impact
| Area | Change |
|------|--------|
| `nexus-agent/src/claude_utils/project.rs` | Fix path from `state/` to `config/`, add `get_project_display()` |
| `nexus-agent/src/services/receiver/delivery.rs` | Banner + APNs title resolution |
| `nexus-agent/src/notification_engine.rs` | TTS prefix resolution |
| `config/notifications.example.toml` | Document projectVoices config |

## Risks
| Risk | Mitigation |
|------|-----------|
| `projects.json` missing on fresh install | Graceful fallback to "🔭 Nexus" / uppercase code |
| Emoji rendering in notifications | macOS natively supports emoji in notification titles |
| OnceLock caching stale data | Acceptable — projects.json changes rarely, restart agent to pick up |
