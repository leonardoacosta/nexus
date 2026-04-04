# Capability: Initial Bootstrap on First Startup

## ADDED Requirements

### Requirement: The system SHALL bootstrap the pool from CC credentials on first run
On first startup, when the credentials directory is empty and `~/.claude/.credentials.json` exists as a real file, the service MUST import it as the first account using the fingerprint naming convention and MUST convert the original file to a symlink pointing to the imported copy.

#### Scenario: First startup with existing CC credentials
Given `~/.config/nexus/credentials/` is empty
And `~/.claude/.credentials.json` exists as a regular file with a valid `claudeAiOauth.accessToken`
When the credential pool service starts
Then the file is copied to `~/.config/nexus/credentials/acct-{fingerprint}.json`
And `~/.claude/.credentials.json` is replaced with a symlink to the copied file
And the imported account is loaded into the in-memory pool
And the service enters the normal watch+poll loop (not passthrough)

#### Scenario: First startup with no CC credentials
Given `~/.config/nexus/credentials/` is empty
And `~/.claude/.credentials.json` does not exist
When the credential pool service starts
Then no import occurs
And the service enters passthrough mode

#### Scenario: First startup with CC credentials already a symlink
Given `~/.config/nexus/credentials/` is empty
And `~/.claude/.credentials.json` is a symlink (pointing somewhere outside the pool)
When the credential pool service starts
Then no import occurs
And the service enters passthrough mode

#### Scenario: Subsequent startup with populated pool
Given `~/.config/nexus/credentials/` contains credential files from a previous run
When the credential pool service starts
Then no bootstrap import occurs
And the service loads existing credentials normally
