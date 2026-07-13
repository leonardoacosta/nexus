# Design: add-git-status-orbit

## Decisions

### Poll-only observation, no fs.watch

Unlike `add-project-status-snapshots`' beads watcher (where `issues.jsonl` is a single
watchable file), git state has no single watch target: dirty state is working-tree-wide —
watching `.git/HEAD` + refs catches branch switches and commits but NOT edits anywhere in the
tree, and watching the whole tree per project is inotify-exhaustion territory. Since this is
orbital (static) data with no sub-minute freshness requirement, a 60s staggered poll — the
spec-watcher's existing cadence and batching shape — covers everything one mechanism can.
Per-project timeout + fail-open skip mirrors the observer conventions established by the
sibling proposal.

### Hot paths stay local (decision locked at exploration)

nexus-statusline (`index.ts:84-101`) and cc-tmux keep their direct `git -C` calls: they render
for the session's cwd (frequently a worktree the agent does not register), local git is ~10ms,
and they must work when the agent is down. The agent serves the cross-machine, historical,
project-root view only. nx-yn6c2 (cc-tmux querying agent endpoints) remains a separate
follow-up once this payload exists.

### Events + in-memory current state, no current-state table

`git_events` is append-only history (the revived committed requirement). Current state (branch,
sha, dirty counts) lives in the observer's in-memory map and is folded into the status payload —
it is fully reconstructible on the next poll after restart, so persisting it would duplicate
data with a 60s shelf life. Dirty state is deliberately NOT evented (it is a state, not a
transition); it appears only in the current-state payload.

### Capability placement of the serving requirement

`add-project-status-snapshots` ADDs the `GET /projects/:id/status` requirement under
`spec-timeseries`, but that delta is unapplied — a MODIFIED against it here would fail
validation (no parent requirement in `openspec/specs/` yet). The git payload extension +
`git-events` history route therefore land as ADDED requirements under `git-event-store`, which
owns git observation semantics. The declared `- depends on:` serializes application order so
the route file exists before this change extends it.

### Identity + multi-machine semantics

Observation keys on `project` name (consistent with `spec_sessions` and the sibling proposal)
over locations on the local machine only (`project_locations` filtered to this agent). Peer
agents each serve their own observed state — consistent with the existing peer-to-peer
topology; no cross-agent aggregation in this change.

## Alternatives rejected

- fs.watch on `.git/HEAD` + refs with poll fallback — catches ref changes but not dirtiness;
  two mechanisms for half the signal each. Poll alone covers both.
- Lifecycle-bus GitEvent emission — no live dashboard consumer asked for it; add when one does
  (the bus entry is a 20-line follow-up, not architecture).
- `git_state` current-state table — restart reconstruction makes persistence redundant (see
  above).
- Replacing statusline/cc-tmux local git with agent queries — worse latency, wrong cwd
  semantics for worktrees, agent-down failure mode on a render hot path.
