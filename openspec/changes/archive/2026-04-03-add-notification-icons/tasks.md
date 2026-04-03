# Implementation Tasks

<!-- beads:epic:TBD -->

## DB Batch

(no database changes)

## API Batch

- [x] [2.1] [P-1] Create `deploy/assets/icons/` directory with PNG icons: `nexus.png` (default) + one per project code — 128x128 optimized PNGs [owner:user]
- [x] [2.2] [P-1] Created `crates/nexus-agent/src/icons.rs` module: embed PNGs via `include_bytes!`, expose `get_icon_path(code) -> Option<PathBuf>` with fallback to nexus.png [owner:api-engineer]
- [x] [2.3] [P-2] Added icon cache logic: write embedded bytes to `~/.cache/nexus/icons/{code}.png` on first use, return cached path; skip write if file exists [owner:api-engineer]
- [x] [2.4] [P-2] Modified `show_notification` in `delivery.rs`: resolve project code to cached icon path, add `-appIcon <path>` arg to terminal-notifier command [owner:api-engineer]

## UI Batch

(no TUI changes)

## E2E Batch

- [x] [4.1] Manual verification: trigger notification with project code, confirm icon appears in macOS Notification Center [owner:user]
