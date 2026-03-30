## 1. Core: Command Metadata Types

- [ ] Create `crates/nexus-core/src/command.rs`
  - `CommandInfo`: name, namespace, full_path, description, tier, estimated_cost_category
  - `CommandTier`: Status (fast, read-only), Analysis (minutes, read-only), Action (mutates state)
  - `CostCategory`: Minimal (no CC), Low (single agent), Medium (2-5 agents), High (5+ agents)
  - `CommandNamespace`: top-level, plan, workflow, audit, apply, monitor, test, ci, project,
    review, beads, openspec, idea

## 2. Service: Command Registry

- [ ] Create `crates/nexus-agent/src/services/command_registry.rs`
  - Scan `~/.claude/commands/` recursively for `.md` files
  - Parse command file frontmatter (if present) for description and metadata
  - Derive namespace from directory structure (e.g., `audit/code.md` → `audit:code`)
  - Exclude `references/` subdirectories (not invocable commands)
  - Exclude `README.md` files
  - Static tier + cost categorization table for known commands
  - Cache command list, reload on file change or explicit refresh

## 3. Proto: Command Discovery Messages

- [ ] Add to `proto/nexus.proto`:
  ```
  message CommandInfo {
    string name = 1;
    string namespace = 2;
    string description = 3;
    CommandTier tier = 4;
    CostCategory cost = 5;
  }
  enum CommandTier { COMMAND_TIER_UNSPECIFIED = 0; STATUS = 1; ANALYSIS = 2; ACTION = 3; }
  enum CostCategory { COST_UNSPECIFIED = 0; MINIMAL = 1; LOW = 2; MEDIUM = 3; HIGH = 4; }
  message ListCommandsRequest { optional string namespace = 1; optional CommandTier tier = 2; }
  message ListCommandsResponse { repeated CommandInfo commands = 1; }
  ```

## 4. Proto: Project Command Execution Messages

- [ ] Add to `proto/nexus.proto`:
  ```
  message RunProjectCommandRequest {
    string project = 1;
    string command = 2;
    repeated string args = 3;
    bool fresh_session = 4;
  }
  ```
  - Response reuses existing `stream CommandOutput`
  - Add `RunProjectCommand` RPC to `NexusAgent` service

## 5. gRPC: Implement ListCommands

- [ ] Wire `ListCommands` in `crates/nexus-agent/src/grpc.rs`
  - Return cached command list from registry
  - Support optional namespace and tier filters
  - Return `CommandInfo` with all metadata fields populated

## 6. gRPC: Implement RunProjectCommand

- [ ] Wire `RunProjectCommand` in `crates/nexus-agent/src/grpc.rs`
  - Resolve project code to path (via project registry)
  - Validate command exists in registry
  - Acquire session from pool (via `SessionPool::get_or_create`)
  - Construct prompt: `/<command> <args>` (slash command format)
  - Execute via existing `SendCommand` machinery (subprocess stream)
  - Release session back to pool on completion
  - Error handling: project not found, command not found, pool unavailable, execution failure

## 7. HTTP: Command Endpoints

- [ ] Add routes to `crates/nexus-agent/src/main.rs`:
  - `GET /commands` — list all commands (supports `?namespace=` and `?tier=` query params)
  - `GET /commands/:namespace` — list commands in namespace
  - `POST /project/:code/run` — execute command `{ "command": "audit:code", "args": [] }`
    Returns streaming JSON (newline-delimited CommandOutput messages)

## 8. Tests

- [ ] Unit tests for command registry scanning and metadata parsing
- [ ] Unit tests for namespace derivation from file paths
- [ ] Integration test: ListCommands returns known commands with correct metadata
- [ ] Integration test: RunProjectCommand with valid project + command streams output
- [ ] Integration test: RunProjectCommand with unknown project returns NOT_FOUND
- [ ] Integration test: RunProjectCommand with unknown command returns INVALID_ARGUMENT
