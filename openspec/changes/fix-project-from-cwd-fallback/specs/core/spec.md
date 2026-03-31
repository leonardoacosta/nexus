## MODIFIED Requirements

### Requirement: Project Detection from Working Directory
The system SHALL detect project codes from session working directories by finding a `dev/` path component and returning the next component. When no `dev/` component exists, the system SHALL return an empty string.

#### Scenario: Standard dev path detected
- **WHEN** `project_from_cwd` is called with `/home/nyaptor/dev/oo/apps/web`
- **THEN** the result is `"oo"`

#### Scenario: Dev root path detected
- **WHEN** `project_from_cwd` is called with `/home/nyaptor/dev/nexus/crates`
- **THEN** the result is `"nexus"`

#### Scenario: System path returns empty
- **WHEN** `project_from_cwd` is called with `/tmp`
- **THEN** the result is `""` (not `"tmp"`)

#### Scenario: Home directory returns empty
- **WHEN** `project_from_cwd` is called with `/home/user`
- **THEN** the result is `""` (not `"user"`)

#### Scenario: Deep system path returns empty
- **WHEN** `project_from_cwd` is called with `/var/log`
- **THEN** the result is `""` (not `"log"`)
