# nexus-decommission Specification

## ADDED Requirements

### Requirement: TTS continuity across the cutover
The system SHALL deliver spoken notifications through the herdr-fronted kokoro pipe before any nexus runtime component is stopped, so no window exists in which a notification is silently lost.

#### Scenario: Kokoro pipe verified before teardown begins
- **WHEN** the decommission run starts and the herdr kokoro health probe returns a non-200 status
- **THEN** the run halts before stopping any nexus unit, and no teardown task executes

#### Scenario: Spoken output confirmed with the agent stopped
- **WHEN** `nexus-agent` is stopped and a Claude Code session triggers a notification
- **THEN** audible kokoro output is produced through the herdr pipe, and the observed result is recorded as runtime evidence

#### Scenario: cc cutover incomplete
- **WHEN** any `nx_send` or `nx_notify` call site remains in `~/dev/cc/scripts` at precondition-check time
- **THEN** the run halts and reports the remaining call sites, because cc still routes notifications through the agent

### Requirement: Data preservation precedes destruction
The system SHALL produce and verify a restorable dump of the `nexus` database before any table, database, or repository content is removed.

#### Scenario: Dump verified by restore
- **WHEN** the `pg_dump` artifact is produced
- **THEN** it is restored into a scratch database and its per-table row counts match the pre-teardown baseline

#### Scenario: Dump unverifiable
- **WHEN** the restore diff shows any row-count mismatch against the baseline
- **THEN** no destructive task runs, and the mismatch is reported for operator resolution

### Requirement: Runtime surface removal
The system SHALL remove every nexus runtime component from the homelab — systemd units, binaries, socket, and configuration directory — such that no nexus process can start.

#### Scenario: Units removed and reboot-clean
- **WHEN** the four nexus systemd user units are stopped, disabled, and deleted, and the machine is rebooted
- **THEN** `systemctl --user list-unit-files` reports zero nexus units, and no journal entry references a missing nexus binary or socket

#### Scenario: Listening port released
- **WHEN** teardown completes
- **THEN** a request to `http://127.0.0.1:7400/health` fails to connect, and the agent socket path is absent

### Requirement: Destructive steps are operator-gated
The system SHALL defer database destruction, repository deletion, and Mac application removal to explicit operator decisions rather than executing them automatically.

#### Scenario: Database disposition deferred
- **WHEN** the automated teardown tasks complete
- **THEN** the `nexus` database still exists, and its disposition is presented to the operator as an explicit choice with the dump artifact path recorded

#### Scenario: Repository disposition deferred
- **WHEN** the automated teardown tasks complete
- **THEN** neither the GitHub repository nor the local checkout has been deleted, and their disposition is presented to the operator as an explicit choice

### Requirement: Fleet reference hygiene
The system SHALL leave no live fleet reference to a retired nexus surface, distinguishing archived history from active configuration.

#### Scenario: Live reference discovered during sweep
- **WHEN** the fleet sweep finds a reference to `nexus-agent`, `:7400`, `nexus-emit`, or `agents.toml` outside an `archive/` path or historical document
- **THEN** a beads issue is filed naming the file and line, and the reference is treated as outstanding work

#### Scenario: Architecture history preserved
- **WHEN** the documentation surfaces are updated
- **THEN** `docs/nexus-topology.html` and `docs/nexus-evolution.html` remain present and carry a dated retirement banner rather than being deleted
