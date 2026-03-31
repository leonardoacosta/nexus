# Capability: Account Name Discovery

## ADDED Requirements

### Requirement: The system SHALL attempt to resolve human-readable account names
After importing a new credential, the system MUST attempt to resolve a human-readable account name from the Anthropic API. If successful, the pool file MUST be renamed from `acct-{fingerprint}.json` to `acct-{sanitized_name}.json`. If the API call fails, the system MUST fall back silently to the fingerprint name.

#### Scenario: API returns an identifiable account name
Given a newly imported credential at `acct-a1b2c3d4.json`
When the name discovery call succeeds and returns a recognizable name (e.g., "personal")
Then the file is renamed to `acct-personal.json`
And the in-memory account entry name is updated to "personal"

#### Scenario: API call fails or returns no name
Given a newly imported credential at `acct-a1b2c3d4.json`
When the name discovery call fails (network error, 401, timeout)
Then the file remains as `acct-a1b2c3d4.json`
And no error is surfaced to the user
And the account functions normally under its fingerprint name

#### Scenario: Name sanitization
Given the API returns a name with special characters (e.g., "Leo's Work Account!")
When the name is sanitized for filesystem use
Then non-alphanumeric characters are replaced with hyphens
And the result is lowercased and truncated to 32 characters

#### Scenario: Name collision with existing pool file
Given the pool contains `acct-personal.json` from a previous import
And a new credential resolves to the same name "personal"
When the rename is attempted
Then the rename is skipped to avoid overwriting a different account
And the new credential retains its fingerprint-based name
