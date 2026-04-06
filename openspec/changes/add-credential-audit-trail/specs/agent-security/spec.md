## ADDED Requirements

### Requirement: State Directory Permission Hardening

The system SHALL create the `~/.config/nexus/state/` directory with
permissions `0o700` (owner read/write/execute only). When the directory is
created via `create_dir_all`, the system MUST explicitly call
`set_permissions` to enforce `0o700` regardless of the process umask. This
prevents other local users from listing directory contents and discovering
usage-data filenames.

#### Scenario: State directory created with restricted permissions

- **WHEN** the agent creates `~/.config/nexus/state/` for the first time
- **THEN** the directory permissions are `0o700` (drwx------)

#### Scenario: Existing state directory permissions corrected

- **WHEN** the agent starts and `~/.config/nexus/state/` already exists with
  permissions more permissive than `0o700`
- **THEN** the agent tightens permissions to `0o700` before writing any state
  files
