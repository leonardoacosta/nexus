# Implementation Tasks

<!-- beads:epic:nexus-sws -->

## API Batch

- [x] [1.1] [P-1] Fix `project.rs` path from `state/projects.json` to `config/projects.json` [owner:api-engineer] [beads:nexus-66g]
- [x] [1.2] [P-1] Add `get_project_display(code) -> (icon, name)` helper returning `("🔭", "Nexus")` fallback [owner:api-engineer] [beads:nexus-66g]
- [x] [1.3] [P-1] Wire display name into banner title in `delivery.rs` — replace raw project code with `"{icon} {name}"` [owner:api-engineer] [beads:nexus-e0c]
- [x] [1.4] [P-1] Wire display name into APNs title in `delivery.rs` — same pattern [owner:api-engineer] [beads:nexus-e0c]
- [x] [1.5] [P-1] Wire display name into TTS prefix at `notification_engine.rs` — use `"{name} —"` (no emoji) [owner:api-engineer] [beads:nexus-e0c]
- [x] [1.6] [P-2] Update `config/notifications.example.toml` with `[project_voices]` section and fallback docs [owner:api-engineer] [beads:nexus-q0i]

## E2E Batch

- [ ] [2.1] [user] Verify banner title shows emoji + display name for known project (manual: trigger notification for `oo`) [owner:e2e-engineer] [beads:nexus-es5]
- [ ] [2.2] [user] Verify fallback title shows "🔭 Nexus" when project is empty or unknown (manual: send socket event without project) [owner:e2e-engineer] [beads:nexus-es5]
- [ ] [2.3] [user] Verify TTS prefix speaks "Otaku Odyssey" not "OO" (manual: listen to TTS output) [owner:e2e-engineer] [beads:nexus-es5]
