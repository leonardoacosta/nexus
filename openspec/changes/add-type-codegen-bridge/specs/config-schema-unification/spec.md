# Spec Delta: Config Schema Unification

## MODIFIED Requirements

### Requirement: AgentConfig Field Parity
The `AgentConfig` definition in Rust and TS MUST agree on field names, types, and optionality so that the same `agents.toml` file parses identically in both languages.

#### Scenario: agents.toml with user and projects_dir parses in both Rust and TS
- **Given** an agents.toml with `user = "leo"` and `projects_dir = "~/dev"` in an agent entry
- **When** parsed by both Rust `NexusConfig::load()` and TS `parseConfig()`
- **Then** both return a valid config with matching field values

#### Scenario: agents.toml without user field parses in both languages
- **Given** an agents.toml where an agent entry omits the `user` field
- **When** parsed by both Rust and TS
- **Then** both accept the config (user defaults to None/undefined)

#### Scenario: agents.toml without projects_dir parses in Rust
- **Given** an agents.toml where an agent entry omits `projects_dir`
- **When** parsed by Rust `NexusConfig::load()`
- **Then** parsing succeeds with `projects_dir = None`

### Requirement: NexusConfig.self_name Optionality Alignment
Both Rust and TS MUST agree on whether `self_name` is required or optional.

#### Scenario: agents.toml without self_name
- **Given** an agents.toml that omits `self_name`
- **When** parsed by both Rust and TS
- **Then** both handle it the same way (both succeed with default, or both require it)

### Requirement: Cross-Language Config Fixture Test
A shared TOML fixture file MUST be parsed by both Rust and TS test suites to detect future drift.

#### Scenario: Shared fixture validates both parsers
- **Given** a fixture file at `tests/fixtures/agents.toml`
- **When** the Rust `config::tests` and TS `config.test.ts` both parse it
- **Then** both extract the same agent count, names, hosts, and ports
