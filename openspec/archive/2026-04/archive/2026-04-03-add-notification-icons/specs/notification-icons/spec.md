# Spec: Notification Icons

## ADDED Requirements

### Requirement: Bundled icon assets
The nexus-agent binary includes PNG icon data for each registered project and a default Nexus icon, embedded at compile time via `include_bytes!`.

#### Scenario: Icon assets exist in repo
Given PNG icons exist at `deploy/assets/icons/{code}.png` for each project
When `cargo build -p nexus-agent` runs
Then the binary includes all icon data without external dependencies

#### Scenario: Default fallback icon
Given a notification arrives for an unknown project code
When the icon resolver looks up the code
Then it returns the path to the default `nexus.png` icon

### Requirement: Icon cache extraction
On first notification (or when cache is stale), embedded PNG bytes are written to `~/.cache/nexus/icons/` so `terminal-notifier` can reference them by file path.

#### Scenario: First notification after fresh install
Given `~/.cache/nexus/icons/` does not exist
When a notification is triggered
Then the directory is created and the relevant icon PNG is written to disk
And the icon path is passed to `terminal-notifier -appIcon`

#### Scenario: Cache already populated
Given `~/.cache/nexus/icons/oo.png` already exists
When a notification for project "oo" is triggered
Then the existing cached file is used without re-writing

## MODIFIED Requirements

### Requirement: show_notification includes icon
The `show_notification` function passes `-appIcon <path>` to `terminal-notifier` when a cached icon path is available.

#### Scenario: macOS notification with project icon
Given the icon cache contains `oo.png`
When `show_notification` is called with project="oo"
Then `terminal-notifier` is invoked with `-appIcon ~/.cache/nexus/icons/oo.png`
And the notification displays the project icon instead of the terminal icon

#### Scenario: Icon cache write fails
Given the cache directory cannot be written (permissions)
When a notification is triggered
Then the notification is sent without `-appIcon` (graceful degradation)
And a debug log is emitted
