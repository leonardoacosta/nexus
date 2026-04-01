# failure-store Specification

## Purpose
TBD - created by archiving change add-sqlite-store. Update Purpose after archive.
## Requirements
### Requirement: The system MUST store failures in SQLite replacing the in-memory buffer
The FailureBuffer MUST write failures to the `failures` table and MUST use SQL queries for aggregation, replacing the hand-rolled VecDeque-based aggregation code.

#### Scenario: Failure event persisted
Given a tool failure event arrives from a CC session
When the FailureBuffer processes it
Then a row is inserted into the failures table

#### Scenario: Aggregation via SQL
Given 100 failures exist in the database
When the /failures endpoint is called with ?group_by=tool
Then the response is generated via `SELECT tool_name, COUNT(*) FROM failures GROUP BY tool_name`

#### Scenario: JSONL bootstrap eliminated
Given the agent starts and failures exist in the SQLite database
When the FailureBuffer initializes
Then it reads from SQLite instead of bootstrapping from JSONL files on disk

