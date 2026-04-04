# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Extract per-agent query logic into a standalone async function that takes owned agent data and returns `(usize, Vec<Session>, bool, Option<MachineHealth>, Option<String>)` [owner:api-engineer]
- [ ] [1.2] [P-1] Replace the sequential `for` loop in `get_sessions` with `tokio::task::JoinSet` to spawn all agent queries concurrently [owner:api-engineer]
- [ ] [1.3] [P-2] Collect results from the JoinSet and write connection status, sessions, and health back to `self.agents` by index [owner:api-engineer]
- [ ] [1.4] [P-2] Verify existing error handling is preserved — failed agents marked Disconnected with empty session list [owner:api-engineer]
