## MODIFIED Requirements

### Requirement: The system MUST provide a SQLite database with schema migrations
The agent MUST create and manage `~/.config/nexus/nexus.db` with WAL mode enabled, schema versioning
via `PRAGMA user_version`, and a shared `NexusDb` wrapper accessible to all services.

#### Scenario: First startup creates database
Given no nexus.db exists at `~/.config/nexus/`
When the agent starts
Then it creates the database, enables WAL mode, runs all migrations to the latest version, and logs "Database initialized at version N"

#### Scenario: Subsequent startup with current version
Given nexus.db exists at version 1
When the agent starts and expects version 1
Then it skips migrations and proceeds normally

#### Scenario: Subsequent startup with older version
Given nexus.db exists at version 1
When the agent starts and expects version 2
Then it runs migration 1→2 and updates user_version to 2

#### Scenario: Database from future version
Given nexus.db exists at version 3
When the agent starts and only knows up to version 2
Then it logs an error and refuses to start (forward-compatibility guard)

## ADDED Requirements

### Requirement: The credentials table MUST store values encrypted with column-level encryption metadata
The `credentials` table MUST contain `value_encrypted text NOT NULL` (replacing the former
`value_plaintext` column) and `encryption_key_id text NOT NULL DEFAULT 'v1'` to track which
encryption key version was used. A `rate_limit_count int NOT NULL DEFAULT 0` column MUST be present
to support weighted round-robin lease selection.

#### Scenario: Schema migration adds encryption columns
Given nexus.db exists at version N (before this migration)
When the agent runs the schema migration
Then `value_encrypted`, `encryption_key_id`, and `rate_limit_count` columns are present in the `credentials` table and `value_plaintext` is absent

#### Scenario: One-time encryption migration script populates value_encrypted
Given the `credentials` table has rows with `value_plaintext` populated and `value_encrypted` NULL
When `scripts/encrypt-credentials.ts` is executed with valid `NEXUS_ENCRYPTION_KEY` and `POSTGRES_URL`
Then every row has `value_encrypted` populated, `encryption_key_id` set to `'v1'`, and no NULL `value_encrypted` rows remain

#### Scenario: Encryption migration script is idempotent
Given all rows already have `value_encrypted` populated
When `scripts/encrypt-credentials.ts` is executed a second time
Then no rows are modified and the script exits successfully

#### Scenario: Column drop migration requires zero NULL encrypted rows
Given `value_encrypted` has been populated for all rows
When the operator applies the column-drop migration
Then `value_plaintext` is removed and `value_encrypted NOT NULL` constraint is enforced
