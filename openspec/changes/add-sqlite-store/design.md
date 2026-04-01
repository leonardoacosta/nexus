# Design: SQLite Backing Store Phase 1

## 3-Phase Roadmap

```
Phase 1 (this spec)          Phase 2 (analytics)         Phase 3 (consolidation)
────────────────────         ───────────────────         ────────────────────────
specs (governance)           health_samples              cron_runs
sessions                     spec_snapshots (timeseries) git_events
failures                     credential_polls            agent_lifecycle
events (audit)               credential_swaps            Eliminate JSON/JSONL files
                             notifications               gRPC analytical RPCs
                                                         TUI sparkline dashboards

4 tables                     5 tables                    3 tables + file removal
~25 tasks                    ~15 tasks                   ~12 tasks
```

## Schema (Phase 1)

```sql
-- Version tracking
PRAGMA user_version = 1;

-- Spec governance: the anchor table
CREATE TABLE specs (
    id TEXT PRIMARY KEY,              -- "oo/add-user-auth" (project/spec-name)
    project TEXT NOT NULL,            -- "oo"
    name TEXT NOT NULL,               -- "add-user-auth"
    status TEXT NOT NULL DEFAULT 'unread',  -- unread|read|approved|rejected|applied|archived
    title TEXT,                       -- from proposal.md # Proposal: line
    summary TEXT,                     -- from ## Summary section
    tasks_total INTEGER DEFAULT 0,
    tasks_done INTEGER DEFAULT 0,
    proposal_hash TEXT,               -- SHA-256 of proposal.md content (detect edits)
    discovered_at TEXT NOT NULL,      -- ISO 8601
    read_at TEXT,
    approved_at TEXT,
    applied_at TEXT,
    archived_at TEXT,
    rejected_at TEXT,
    rejection_reason TEXT
);
CREATE INDEX idx_specs_project ON specs(project);
CREATE INDEX idx_specs_status ON specs(status);

-- Session persistence: write-through from SessionRegistry
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    pid INTEGER,
    project TEXT,
    cwd TEXT,
    branch TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    last_heartbeat TEXT,
    status TEXT,
    model TEXT,
    session_type TEXT,
    total_cost_usd REAL,
    rate_limit_utilization REAL,
    rate_limit_type TEXT,
    tmux_target TEXT,
    cc_session_id TEXT,
    agent TEXT
);
CREATE INDEX idx_sessions_project ON sessions(project);
CREATE INDEX idx_sessions_started ON sessions(started_at);

-- Failure store: replaces VecDeque + JSONL
CREATE TABLE failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    error_summary TEXT,
    project TEXT,
    session_id TEXT
);
CREATE INDEX idx_failures_timestamp ON failures(timestamp);
CREATE INDEX idx_failures_tool ON failures(tool_name);
CREATE INDEX idx_failures_project ON failures(project);

-- Audit event log
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,    -- session_start, session_stop, credential_swap, spec_approved, etc.
    actor TEXT,                  -- session_id, "user", "cron", etc.
    target TEXT,                 -- spec_name, session_id, account_name
    details TEXT                 -- JSON blob for event-specific data
);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_type ON events(event_type);
```

## Connection Architecture

```
                    ┌──────────────┐
                    │  nexus.db    │
                    │  (WAL mode)  │
                    └──────┬───────┘
                           │
                    Arc<NexusDb>
                    ┌──────┴───────┐
                    │ r/w Mutex    │
                    │ for writes   │
                    │              │
                    │ concurrent   │
                    │ reads via    │
                    │ WAL          │
                    └──────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     SpecWatcher     SessionRegistry  FailureBuffer
     (write specs)   (write sessions) (write failures)
            │              │              │
            └──────────────┼──────────────┘
                           │
                    HTTP handlers
                    (read queries)
```

`NexusDb` wrapper in nexus-core:
```rust
pub struct NexusDb {
    conn: Mutex<rusqlite::Connection>,
}

impl NexusDb {
    pub fn open(path: &Path) -> Result<Self> { ... }
    pub fn migrate(&self) -> Result<()> { ... }
    pub fn write<F, T>(&self, f: F) -> Result<T> where F: FnOnce(&Connection) -> Result<T> { ... }
    pub fn read<F, T>(&self, f: F) -> Result<T> where F: FnOnce(&Connection) -> Result<T> { ... }
}
```

## Spec Governance Flow

```
SpecWatcher polls openspec/changes/ across projects
    │
    ▼
New spec found → INSERT INTO specs (status='unread')
    │
    ▼
TUI shows "3 specs pending review" in status bar
    │
    ▼
Leo opens spec detail → auto-marks as 'read' (UPDATE status, read_at)
    │
    ▼
Leo presses 'a' to approve → UPDATE status='approved', approved_at
    or 'x' to reject   → UPDATE status='rejected', rejected_at, reason
    │
    ▼
/apply checks: SELECT status FROM specs WHERE id = ?
    → 'approved' → proceed
    → anything else → BLOCK with message
    │
    ▼
After apply completes → UPDATE status='applied', applied_at
    │
    ▼
After archive → UPDATE status='archived', archived_at
```

## Proposal Hash Change Detection

```
Poll cycle finds spec "oo/add-user-auth"
    │
    ├── Compute SHA-256 of proposal.md content
    │
    ├── Compare with stored proposal_hash
    │   │
    │   ├── MATCH → no action (spec unchanged)
    │   │
    │   └── MISMATCH (spec was edited after review)
    │       │
    │       ├── If status was 'read' or 'approved'
    │       │   → Reset to 'unread', clear read_at/approved_at
    │       │   → TTS: "Spec add-user-auth in oo was modified — needs re-review"
    │       │
    │       └── Update proposal_hash
```

## Retention

The existing `maintain` cron job (daily@00:17) adds:
```sql
DELETE FROM sessions WHERE ended_at < datetime('now', '-30 days');
DELETE FROM failures WHERE timestamp < datetime('now', '-30 days');
DELETE FROM events WHERE timestamp < datetime('now', '-30 days');
DELETE FROM specs WHERE status = 'archived' AND archived_at < datetime('now', '-90 days');
```

Specs get 90-day retention (longer than sessions/failures) since they're governance records.
