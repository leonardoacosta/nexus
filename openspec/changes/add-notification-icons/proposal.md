# Proposal: Per-Project Notification Icons

## Change ID
`add-notification-icons`

## Summary
Replace the generic terminal icon in macOS desktop notifications with per-project PNG icons, bundled in the nexus-agent binary via `include_bytes!` and resolved by project code at notification time.

## Context
- Extends: `crates/nexus-agent/src/services/receiver/delivery.rs` (show_notification), `crates/nexus-agent/src/claude_utils/project.rs` (project display)
- Related: Archived `add-project-aware-notifications` explicitly scoped this out as "future — requires PNG assets"

## Motivation
All Nexus notifications show a generic terminal icon (terminal-notifier's default). Teams and Telegram show distinct brand icons, making it easy to identify the source at a glance. With 14+ projects running concurrent Claude sessions, visual project identity in the notification tray is essential. Per-project emoji icons already exist in `projects.json` but emojis don't work as macOS notification icons — PNG images are needed.

## Requirements

### Req-1: Bundled icon asset pipeline
The nexus-agent binary embeds a set of PNG icons (one per known project + a default Nexus icon) via `include_bytes!`. At runtime, icons are extracted to a cache directory and the path is passed to `terminal-notifier -appIcon`.

### Req-2: Per-project icon resolution
When `show_notification` is called with a project code, the system resolves that code to the corresponding bundled PNG. Unknown projects fall back to the default Nexus icon.

### Req-3: Icon cache management
Bundled icons are written to `~/.cache/nexus/icons/` on first use (or when the binary version changes). Avoids writing to `/tmp` on every notification.

## Scope
- **IN**: Bundled PNG icons, per-project resolution, terminal-notifier `-appIcon` flag, icon cache directory, default Nexus fallback icon
- **OUT**: User-customizable icons via config, Linux notify-send icons (future), dynamic icon download, per-project icons in the TUI

## Impact
| Area | Change |
|------|--------|
| `delivery.rs` | Add `-appIcon` arg to terminal-notifier command |
| `project.rs` or new `icons.rs` | Icon resolution: project code → cached PNG path |
| `deploy/assets/icons/` | PNG icon assets checked into repo |
| `Cargo.toml` | No new deps (include_bytes! is std) |

## Risks
| Risk | Mitigation |
|------|-----------|
| Binary size increase from embedded PNGs | Use optimized 128x128 PNGs (~10-20KB each). 15 icons ≈ 200KB total — negligible |
| Icon cache directory permissions | Create with user-owned perms, fallback to no icon if write fails |
| terminal-notifier `-appIcon` not supported on older macOS | Flag available since Mavericks (10.9) — safe for all modern macOS |
