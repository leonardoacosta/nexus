# failure-store Delta

> **Context note**: The existing requirements in `openspec/specs/failure-store/spec.md`
> describe the Rust-era SQLite-backed FailureBuffer. That implementation
> was decommissioned during the Bun spine migration (P4) — the SQLite
> table is no longer the source of truth. This delta documents the
> replacement JSONL-aggregate pipeline. A future cleanup proposal
> should REMOVE the obsolete SQLite-buffer requirements; doing so here
> would conflate "fix the empty endpoint" with "rewrite the capability
> doc" and bloat the diff. The dead requirements are inert (no code
> implements them).

## ADDED Requirements

### Requirement: jsonl-aggregate-pipeline
The agent's `GET /failures?days=N` endpoint MUST aggregate CC tool-failure data from `~/.claude/scripts/state/failures/*.jsonl` files. Each JSONL line is parsed as `{ timestamp, tool_name, error_snippet, command_snippet, project, session_id }`. The aggregation MUST be cached per `days` argument with a 60-second TTL. Memory ceiling: the implementation MUST stream lines via `Bun.file().stream()` rather than buffering whole files. Maximum window: `days > 90` returns `400 { error: "max window is 90 days" }`.

#### Scenario: empty filesystem
- **Given** `~/.claude/scripts/state/failures/` exists but contains zero `.jsonl` files
- **When** `GET /failures?days=7` is called
- **Then** the response is `200 { total: 0, by_tool: {}, by_project: {}, top_errors: [], trend: { current: 0, previous: 0, direction: "flat" }, source: "jsonl", parse_errors: 0 }`

#### Scenario: populated single day
- **Given** `~/.claude/scripts/state/failures/2026-05-21.jsonl` contains 5 lines: 3 Read failures, 2 Bash failures, all for project `nx`
- **When** `GET /failures?days=1` is called
- **Then** the response has `total: 5`, `by_tool: { Read: 3, Bash: 2 }`, `by_project: { nx: 5 }`, and `top_errors[]` contains aggregated entries with stable count-sorted ordering

#### Scenario: malformed line tolerated
- **Given** the JSONL file has 10 valid lines and 2 truncated lines (incomplete JSON)
- **When** the endpoint is called
- **Then** the response includes `total: 10` (only the parseable lines) and `parse_errors: 2`; no 500 is returned

#### Scenario: max window enforced
- **Given** any caller
- **When** `GET /failures?days=91` is called
- **Then** the response is `400 { error: "max window is 90 days" }`

#### Scenario: cache hit within 60s
- **Given** `GET /failures?days=7` was called 30 seconds ago and the result was cached
- **When** the same query is called again
- **Then** no JSONL files are re-read; the cached aggregate is returned identically

### Requirement: top-errors-fingerprinting
The `top_errors[]` rows in the `/failures` response MUST be deduplicated by stable fingerprint computed as `sha256(tool_name + error_snippet[:200])`. Each row's `count` field MUST equal the dedup multiplicity. The first occurrence's `command_snippet` MUST be preserved verbatim as the row's `command` field. Rows MUST be ordered by `count` descending, with stable tie-break by `tool_name` ascending. Maximum 20 rows returned. Each row MUST include `trace_id: null` and `stack_truncated: false` (the JSONL schema doesn't carry these fields; the contract is preserved for forward compatibility with a future DB-backed source).

#### Scenario: dedup by tool + error snippet
- **Given** 5 JSONL lines for tool `Read` with identical `error_snippet`
- **When** the endpoint is called
- **Then** `top_errors[]` contains ONE row for that fingerprint with `count: 5`

#### Scenario: count-sorted output
- **Given** 3 distinct fingerprints with counts 12, 4, 7
- **When** the endpoint is called
- **Then** the rows appear in order `[12, 7, 4]`

#### Scenario: 20-row cap
- **Given** 30 distinct fingerprints exist
- **When** the endpoint is called
- **Then** exactly 20 rows are returned (the top 20 by count); the response total still reflects the full population

### Requirement: trend-computation
The `/failures` response MUST include a `trend: { current, previous, direction }` object where `current` is the aggregate count over `[now - days, now]`, `previous` is the count over `[now - 2*days, now - days]`, and `direction` is `"up"` when `current > previous * 1.1`, `"down"` when `current < previous * 0.9`, else `"flat"`. When `previous == 0` and `current > 0`, `direction` MUST be `"up"`. When both are 0, `direction` MUST be `"flat"`.

#### Scenario: significant increase
- **Given** current window has 50 failures, previous window has 10
- **When** the endpoint is called
- **Then** `trend: { current: 50, previous: 10, direction: "up" }`

#### Scenario: flat trend within 10% band
- **Given** current 22, previous 20 (10% delta)
- **When** the endpoint is called
- **Then** `trend.direction: "flat"` (within band — 22 is not greater than 20*1.1=22)

#### Scenario: zero-to-nonzero is up
- **Given** previous 0, current 3
- **When** the endpoint is called
- **Then** `trend.direction: "up"`

### Requirement: source-provenance-field
The `/failures` response MUST include a `source: "jsonl"` field naming the active data source. The Swift `FailureSummary` decoder MUST accept this field as optional (`String?`) for back-compat with older agents that omit it.

#### Scenario: response includes source
- **When** `GET /failures` is called against the JSONL-backed agent
- **Then** the response body contains `"source": "jsonl"`

#### Scenario: older agent omits source
- **Given** a hypothetical older agent that returns no `source` field
- **When** the Swift decoder reads the response
- **Then** decoding succeeds; `FailureSummary.source` is `nil`
