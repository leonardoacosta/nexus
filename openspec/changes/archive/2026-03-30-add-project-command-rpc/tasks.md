<!-- beads:epic:nexus-35g -->

## 1. Core: Command Metadata Types [beads:nexus-56a]

- [x] Create `crates/nexus-core/src/command.rs`
  - `CommandInfo`: name, namespace, full_path, description, tier, estimated_cost_category
  - `CommandTier`: Status (fast, read-only), Analysis (minutes, read-only), Action (mutates state)
  - `CostCategory`: Minimal (no CC), Low (single agent), Medium (2-5 agents), High (5+ agents)
  - `CommandNamespace`: top-level, plan, workflow, audit, apply, monitor, test, ci, project,
    review, beads, openspec, idea

## 2. Service: Command Registry [beads:nexus-0i4]

- [x] Create `crates/nexus-agent/src/services/command_registry.rs`
  - Scan `~/.claude/commands/` recursively for `.md` files
  - Parse command file frontmatter (if present) for description and metadata
  - Derive namespace from directory structure (e.g., `audit/code.md` → `audit:code`)
  - Exclude `references/` subdirectories (not invocable commands)
  - Exclude `README.md` files
  - Static tier + cost categorization table for known commands
  - Cache command list, reload on file change or explicit refresh

## 3. Proto: Command Discovery Messages [beads:nexus-2by]

- [x] Add to `proto/nexus.proto`:
  - `CommandInfo` message with name, namespace, description, tier, cost fields
  - `CommandTier` enum
  - `CostCategory` enum
  - `ListCommandsRequest` with optional namespace and tier filters
  - `ListCommandsResponse` with repeated CommandInfo

## 4. Proto: Project Command Execution Messages [beads:nexus-0kd]

- [x] Add to `proto/nexus.proto`:
  - `RunProjectCommandRequest` with project, command, args, fresh_session fields
  - `RunProjectCommand` RPC on NexusAgent service (reuses stream CommandOutput)
  - `ListCommands` RPC on NexusAgent service

## 5. gRPC: Implement ListCommands [beads:nexus-fyj]

- [x] Wire `ListCommands` in `crates/nexus-agent/src/grpc.rs`
  - Return cached command list from registry
  - Support optional namespace and tier filters
  - Return `CommandInfo` with all metadata fields populated

## 6. gRPC: Implement RunProjectCommand [beads:nexus-bxu]

- [x] Wire `RunProjectCommand` in `crates/nexus-agent/src/grpc.rs`
  - Resolve project code to path (via project registry)
  - Validate command exists in registry
  - Acquire session from pool (via `SessionPool::get_or_create`)
  - Construct prompt: `/<command> <args>` (slash command format)
  - Execute via existing `SendCommand` machinery (subprocess stream)
  - Release session back to pool on completion
  - Error handling: project not found, command not found, pool unavailable, execution failure

## 7. HTTP: Command Endpoints [beads:nexus-an0]

- [x] Add routes to `crates/nexus-agent/src/main.rs`:
  - `GET /commands` — list all commands (supports `?namespace=` and `?tier=` query params)
  - `GET /commands/:namespace` — list commands in namespace
  - `POST /project/:code/run` — execute command `{ "command": "audit:code", "args": [] }`
    Returns streaming JSON (newline-delimited CommandOutput messages)

## 8. Tests [beads:nexus-kbs]

- [x] Unit tests for command registry scanning and metadata parsing
- [x] Unit tests for namespace derivation from file paths
- [x] Integration test: ListCommands returns known commands with correct metadata
- [x] Integration test: RunProjectCommand with unknown project returns NOT_FOUND
- [x] Integration test: RunProjectCommand with unknown command returns INVALID_ARGUMENT
