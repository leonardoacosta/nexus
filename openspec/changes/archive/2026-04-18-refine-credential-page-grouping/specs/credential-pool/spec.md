# credential-pool Delta

## ADDED Requirements

### Requirement: The agent MUST track the active Claude Code credential via filesystem watch
The agent MUST watch `~/.claude/.credentials.json` (resolving symlink targets via realpath) and publish the refresh-token fingerprint of the currently-active credential. The watch MUST be independent of the pool-directory watcher and MUST tolerate the absence of the file (reporting `null` activeFingerprint) without error.

#### Scenario: active credential resolved at startup
- **Given** `~/.claude/.credentials.json` is a symlink to `~/.config/nexus/credentials/acct-personal.json`
- **And** `acct-personal.json` has a refresh token that fingerprints to `FP1`
- **When** the agent starts
- **Then** the active fingerprint is published as `FP1` within 2 seconds

#### Scenario: active credential changes at runtime
- **Given** the active fingerprint is `FP1` via symlink to `acct-personal.json`
- **When** the symlink is atomically swapped to point at `acct-work.json` (fingerprint `FP2`)
- **Then** the active fingerprint updates to `FP2` within 2 seconds, debounced to avoid flapping during a swap sequence

#### Scenario: active credential file absent
- **Given** `~/.claude/.credentials.json` does not exist
- **When** the agent starts or the file is later removed
- **Then** the active fingerprint is published as `null` without logging an error

#### Scenario: active credential not managed by Nexus
- **Given** `~/.claude/.credentials.json` exists but contains a refresh token whose fingerprint does not match any pool row
- **When** the agent parses the file
- **Then** the active fingerprint is published as the computed value (non-null) and the pool is not mutated

---

### Requirement: The agent MUST expose the active fingerprint over HTTP
The agent MUST expose `GET /credentials/active` returning `{ fingerprint: string | null, resolvedPath: string | null, observedAt: ISO8601 }`. The `activeFingerprint` field MUST additionally be merged into the response of `GET /credentials` to allow the page to render active state without a second round trip.

#### Scenario: active endpoint returns current state
- **Given** the active fingerprint was last observed as `FP1` resolved from `/home/user/.config/nexus/credentials/acct-personal.json`
- **When** a client calls `GET /credentials/active`
- **Then** the response is `{ fingerprint: "FP1", resolvedPath: "/home/user/.config/nexus/credentials/acct-personal.json", observedAt: "<ISO timestamp>" }`

#### Scenario: list endpoint includes active fingerprint
- **Given** the pool contains credentials across 2 fingerprints and the active fingerprint is `FP2`
- **When** a client calls `GET /credentials`
- **Then** the response body includes `activeFingerprint: "FP2"` alongside the existing credential list
