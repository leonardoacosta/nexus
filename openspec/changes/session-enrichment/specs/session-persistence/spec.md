## ADDED Requirements

### Requirement: Session agent-state derivation

The agent SHALL derive and persist an `agentState` for each session — one of `blocked`,
`waiting`, or `ready` — from the Claude Code lifecycle hook stream, independent of the existing
`status` liveness field.

#### Scenario: Tool execution marks the session blocked

- **WHEN** the agent receives a `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, or
  `SubagentStart` hook for a session
- **THEN** the session's `agentState` SHALL be set to `blocked`

#### Scenario: Notification awaiting input marks the session waiting

- **WHEN** the agent receives a `Notification` hook indicating the agent is awaiting user input
  (permission prompt or idle notification)
- **THEN** the session's `agentState` SHALL be set to `waiting`

#### Scenario: Turn end marks the session ready

- **WHEN** the agent receives a `Stop` hook for a session
- **THEN** the session's `agentState` SHALL be set to `ready`

#### Scenario: agentState is exposed to clients

- **WHEN** a client fetches sessions via the agent's sessions route
- **THEN** each session payload SHALL include its current `agentState`

### Requirement: Session git branch capture

The agent SHALL populate each session's `branch` field with the current git branch of the
session's working directory, captured fail-soft.

#### Scenario: Branch resolved on session discovery

- **WHEN** the process-watcher creates or updates a session whose working directory is inside a
  git repository
- **THEN** the session's `branch` SHALL be set to the output of `git rev-parse --abbrev-ref HEAD`
  for that directory

#### Scenario: Non-git or failed resolution degrades cleanly

- **WHEN** the session's working directory is not a git repository, or the branch lookup fails
- **THEN** the session's `branch` SHALL be `null` and no error SHALL be surfaced to the user

### Requirement: Session row signal rendering

The dashboard session row SHALL present agent state and branch as its primary signals and SHALL
NOT render the originating-agent sentinel label.

#### Scenario: Row badge reflects agent state

- **WHEN** a session row is rendered
- **THEN** its status sigil SHALL reflect the session's `agentState` (`blocked`, `waiting`, or
  `ready`)

#### Scenario: Row subtitle shows branch

- **WHEN** a session row is rendered and the session has a non-empty `branch`
- **THEN** the row subtitle SHALL display the branch rather than the model name

#### Scenario: Agent-name sentinel is not shown

- **WHEN** a session row is rendered
- **THEN** the row SHALL NOT display the `"pinned"` originAgent sentinel label
