# credential-page-status Delta

## ADDED Requirements

### Requirement: Accounts are the top-level row
The credentials page MUST render one row per account, where an account is defined by a unique OAuth refresh-token fingerprint. Each account row MUST be expandable to show the underlying snapshot files (duplicate group members). The page header account count MUST reflect account cardinality, not file cardinality.

#### Scenario: two accounts with three snapshot files total
- **Given** the pool contains fingerprint `FP1` (files `acct-a.json`, `acct-a-backup.json`) and fingerprint `FP2` (file `acct-b.json`)
- **When** the credentials page renders
- **Then** exactly 2 rows are visible at the top level and the header shows "2 accounts"
- **And** expanding the `FP1` row reveals both snapshot files, newest-mtime first

#### Scenario: single-file account renders without expansion affordance
- **Given** fingerprint `FP2` has exactly one snapshot file
- **When** the account row renders
- **Then** no expand control is shown; the row is flat

---

### Requirement: Usage limits rendered per account
Each account row MUST display 5-hour usage percent and reset timestamp. When usage data has not yet been polled for that account, a "not polled yet" fallback MUST be shown instead of blank or zero.

#### Scenario: usage polled for primary credential
- **Given** `GET /credentials/{id}/usage?window=5h` returns `{ percent: 62, resetsAt: "2026-04-17T15:00:00Z" }` for primary of `FP1`
- **When** the account row renders
- **Then** the usage cell shows "62%" and a relative reset time ("in 42 min")

#### Scenario: usage unpolled for new account
- **Given** fingerprint `FP3` was added 10 seconds ago and no usage poll has completed
- **When** the account row renders
- **Then** the usage cell shows "not polled yet" with a spinner affordance

---

### Requirement: Active-account indicator
Exactly one account (or zero, when `~/.claude/.credentials.json` is absent) MUST be marked as active for Claude Code, based on the `activeFingerprint` field returned by the agent. The indicator MUST be a distinct visual badge visible without expanding the row.

#### Scenario: account matching activeFingerprint is badged
- **Given** the agent response includes `activeFingerprint: "FP1"`
- **When** the page renders
- **Then** the `FP1` account row displays an "Active" badge and no other row does

#### Scenario: no active credential resolved
- **Given** `~/.claude/.credentials.json` does not exist and the agent returns `activeFingerprint: null`
- **When** the page renders
- **Then** no account row shows an active badge and a header hint reads "no active credential detected"

#### Scenario: active fingerprint not present in the pool
- **Given** `activeFingerprint: "FPX"` but no pool row has fingerprint `FPX`
- **When** the page renders
- **Then** no account row is badged and a warning chip reads "active credential not managed by Nexus"

---

## MODIFIED Requirements

### Requirement: Agent source attribution in page header
When credentials load successfully, the page header MUST display the name of the responding agent (e.g., "via omarchy") next to the **account count** (formerly "account count" referred to file count; now refers to distinct fingerprints).

#### Scenario: header reflects account cardinality
- **Given** `fetchCredentials()` returns 4 snapshot files grouped into 2 accounts
- **When** the page header renders
- **Then** it reads "2 accounts · via omarchy"
