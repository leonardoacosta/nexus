# Capability: Auto-Create Credentials Directory

## MODIFIED Requirements

### Requirement: The system SHALL create the credentials directory on startup
The credential pool service MUST create `~/.config/nexus/credentials/` with `create_dir_all()` if it does not exist, instead of entering passthrough mode. Passthrough mode MUST only activate when the directory exists, is empty, AND no importable CC credential file is detected.

#### Scenario: Directory does not exist on startup
Given `~/.config/nexus/credentials/` does not exist
When the credential pool service starts
Then the directory is created with `create_dir_all()`
And the service proceeds to scan the (empty) directory
And checks `~/.claude/.credentials.json` for bootstrap eligibility

#### Scenario: Directory exists but is empty with no CC credentials
Given `~/.config/nexus/credentials/` exists and is empty
And `~/.claude/.credentials.json` does not exist or is already a managed symlink
When the credential pool service starts
Then the service enters passthrough mode (no-op until shutdown)

#### Scenario: Directory exists with credential files
Given `~/.config/nexus/credentials/` contains one or more `.json` files
When the credential pool service starts
Then existing behavior is preserved: scan, parse, watch, poll
