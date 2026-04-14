## ADDED Requirements

### Requirement: The sessions table MUST record the credential in effect at session start

The `sessions` table SHALL include two nullable columns: `credential_id` (foreign
key to `credentials.id`) and `credential_fingerprint` (denormalized copy of the
credential's fingerprint for aggregation rollup across duplicate groups). Both
columns MUST be populated at `session_start` from the credential pool's current
lease state. If no lease is active at `session_start`, both columns SHALL be
NULL and token tracking SHALL be skipped for that session without failing the
session lifecycle.

#### Scenario: Session start with active lease records credential
- **GIVEN** the credential pool has credential "c1" (fingerprint "fp-abc") leased
- **WHEN** a new session is created via `session_start`
- **THEN** the sessions row has `credential_id = "c1"` and `credential_fingerprint = "fp-abc"`

#### Scenario: Session start without lease leaves credential columns NULL
- **GIVEN** the credential pool has no active lease (passthrough mode)
- **WHEN** a new session is created via `session_start`
- **THEN** the sessions row has `credential_id = NULL` and `credential_fingerprint = NULL`
- **AND** no token watcher is attached for that session

#### Scenario: credential_fingerprint survives credential deletion
- **GIVEN** session "s1" was started with `credential_id = "c1"` and `credential_fingerprint = "fp-abc"`
- **WHEN** credential "c1" is deleted from the credentials table
- **THEN** `sessions.credential_fingerprint` on "s1" still equals "fp-abc"
- **AND** `GET /sessions/s1/tokens` aggregates still group under the "fp-abc" fingerprint

### Requirement: The system MUST attach a transcript token watcher on session start

On each `session_start` event, the agent SHALL compute the transcript JSONL path
as `~/.claude/projects/${cwd.replaceAll('/', '-')}/${cc_session_id}.jsonl` and
attach a tail watcher to that file. If the file does not exist at
`session_start`, the agent SHALL watch the parent directory via non-recursive
`fs.watch` for up to 5 seconds and attach the tail watcher when the file is
created. On 5-second timeout, the agent SHALL log a WARN once and skip token
tracking for the session without failing the session lifecycle.

#### Scenario: Transcript file exists immediately
- **GIVEN** the transcript JSONL file already exists at `session_start`
- **WHEN** the watcher lifecycle runs
- **THEN** the tail reader is attached and the first batch is parsed within one event loop tick

#### Scenario: Transcript file appears within 5s window
- **GIVEN** the transcript JSONL file does not exist at `session_start`
- **WHEN** the file is created 500ms later
- **THEN** the parent-directory watcher fires and the tail reader attaches to the new file

#### Scenario: Transcript file never appears within window
- **GIVEN** the transcript JSONL file does not exist at `session_start`
- **WHEN** the 5-second timeout elapses with no file creation
- **THEN** a WARN-level log is emitted once for that session
- **AND** no token watcher is attached
- **AND** the session lifecycle continues normally with NULL token data

### Requirement: Token watcher state MUST persist across agent restarts

The agent SHALL persist each active session's tail byte offset in a
`session_token_watcher_state` table keyed by `session_id`, with
`transcript_path`, `byte_offset`, and `updated_at` columns. The `byte_offset`
SHALL be updated in the same database transaction as each batch of inserted
turn rows. On agent startup, the agent SHALL load watcher state for every
session that is still active and resume tailing from the stored offset.

#### Scenario: Watcher resumes at stored offset after restart
- **GIVEN** session "s1" is active and the watcher has stored `byte_offset = 4096`
- **WHEN** the agent restarts
- **THEN** the tail reader opens the transcript file with `start: 4096` and continues parsing new lines from that position

#### Scenario: Resume after mid-batch crash does not produce duplicates
- **GIVEN** the watcher inserted 10 turn rows but crashed before persisting the new offset
- **WHEN** the agent restarts and resumes from the previous offset
- **THEN** the re-read attempts to re-insert the 10 rows
- **AND** the `UNIQUE(session_id, ts)` constraint rejects the duplicates without error
- **AND** the watcher advances past them on the next batch

#### Scenario: Stopped sessions do not resume
- **GIVEN** session "s2" has status `ended` and a stale `session_token_watcher_state` row
- **WHEN** the agent restarts
- **THEN** the watcher for "s2" is NOT reattached
- **AND** the stale watcher state row is pruned

### Requirement: The system MUST stop token watching on session stop

On each `session_stop` event, the agent SHALL flush any pending turn batch,
close the tail reader, and remove the session's row from
`session_token_watcher_state`. Subsequent reads of the transcript file SHALL
NOT be performed for ended sessions.

#### Scenario: Session stop flushes pending batch
- **GIVEN** the watcher has 3 parsed turns buffered but not yet inserted
- **WHEN** a `session_stop` event arrives for that session
- **THEN** the 3 turns are inserted in a final batch before the stream closes

#### Scenario: Session stop removes watcher state
- **GIVEN** session "s3" has a `session_token_watcher_state` row
- **WHEN** `session_stop` fires for "s3"
- **THEN** the watcher-state row is deleted in the same transaction as the final batch insert
