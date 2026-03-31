# Capability: Token Fingerprinting and Auto-Import

## ADDED Requirements

### Requirement: The system SHALL derive a stable fingerprint from access tokens
The system MUST compute a SHA-256 hash of the OAuth access token and use the first 8 hexadecimal characters as a deterministic account fingerprint for naming pool files.

#### Scenario: Fingerprint is deterministic
Given an access token "tok-abc123"
When `fingerprint_token("tok-abc123")` is called twice
Then both calls return the same 8-character hex string

#### Scenario: Different tokens produce different fingerprints
Given access tokens "tok-abc123" and "tok-xyz789"
When `fingerprint_token()` is called on each
Then the returned fingerprints differ

### Requirement: The system SHALL detect managed symlinks before importing
Before importing `~/.claude/.credentials.json` into the pool, the system MUST check whether the file is a symlink whose target resides inside `~/.config/nexus/credentials/`. If so, the import MUST be skipped.

#### Scenario: CC credential file is a managed symlink
Given `~/.claude/.credentials.json` is a symlink to `~/.config/nexus/credentials/acct-a1b2c3d4.json`
When the credential watcher detects a change to `.credentials.json`
Then the import bridge skips the file
And no new file is written to the pool directory

#### Scenario: CC credential file is a real file
Given `~/.claude/.credentials.json` is a regular file (not a symlink)
When the credential watcher detects a change to `.credentials.json`
Then the import bridge computes the token fingerprint
And copies the file to `~/.config/nexus/credentials/acct-{fingerprint}.json`

### Requirement: The system SHALL auto-import credentials on file change
When the credential watcher detects a modification to `~/.claude/.credentials.json` and the file is not a managed symlink, the system MUST compute the token fingerprint and copy the file to the pool directory. If a file with the same fingerprint exists, it MUST be overwritten.

#### Scenario: New account detected via fingerprint
Given the pool directory does not contain `acct-{fingerprint}.json`
When a non-symlink `.credentials.json` is modified with a new access token
Then a new file `acct-{fingerprint}.json` is created in the pool directory
And the credential pool file watcher picks up the new file automatically

#### Scenario: Existing account token refreshed
Given the pool directory contains `acct-{fingerprint}.json`
When `.credentials.json` is modified but produces the same fingerprint
Then the existing pool file is overwritten with the updated content
