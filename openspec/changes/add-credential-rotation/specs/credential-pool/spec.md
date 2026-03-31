# Capability: Credential Pool

## ADDED Requirements

### Requirement: The system SHALL manage credential files
The agent MUST discover and parse OAuth credential files from `~/.config/nexus/credentials/`.

#### Scenario: Startup with credentials directory
Given the directory `~/.config/nexus/credentials/` contains `acct-personal.json` and `acct-work.json`
When the agent starts
Then it parses both files and registers two `CredentialAccount` entries with name, path, and access_token

#### Scenario: Startup without credentials directory
Given `~/.config/nexus/credentials/` does not exist
When the agent starts
Then the credential pool operates in passthrough mode with zero accounts and no interception

#### Scenario: Credential file added at runtime
Given the agent is running with one credential
When a new file `acct-team.json` is created in the credentials directory
Then the watcher detects the change and adds the new account to the pool within 2 seconds

#### Scenario: Credential file removed at runtime
Given the agent is running with three credentials and `acct-team.json` is the active credential
When `acct-team.json` is deleted from the credentials directory
Then the account is removed from the pool and the symlink is swapped to the next best account

### Requirement: The system SHALL poll the usage API with hybrid strategy
The service MUST poll the Anthropic usage API for each credential on a 5-minute interval and MUST immediately poll on rate limit detection.

#### Scenario: Proactive polling
Given two credentials are registered
When the 5-minute poll interval fires
Then the service queries `/api/oauth/usage` for each credential's access token and updates utilization and resets_at

#### Scenario: On-demand polling on rate limit
Given a rate limit event is detected
When the interceptor requests current usage
Then the service immediately polls all credentials (bypassing the interval) and returns fresh data

#### Scenario: Usage cache persistence
Given usage data has been polled for all credentials
When the poll completes
Then results are written to `~/.config/nexus/state/usage-cache.json` atomically

#### Scenario: Startup with cached usage
Given `~/.config/nexus/state/usage-cache.json` exists with data less than 10 minutes old
When the agent starts
Then it loads cached usage data immediately and defers the first API poll to the next interval
