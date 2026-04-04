## MODIFIED Requirements

### Requirement: ReceiverService bind address from NexusConfig
The ReceiverService SHALL bind its TCP listener to the `bind_address` configured in `agents.toml` (via `NexusConfig`), rather than hardcoding `0.0.0.0`. The bind address SHALL be passed into the ReceiverService at construction time.

#### Scenario: Default bind to localhost
- **WHEN** no `bind_address` is configured in agents.toml
- **THEN** the ReceiverService binds to `127.0.0.1:9999`

#### Scenario: Explicit bind to all interfaces
- **WHEN** `bind_address = "0.0.0.0"` is set in agents.toml
- **THEN** the ReceiverService binds to `0.0.0.0:9999`

#### Scenario: Consistency with main servers
- **WHEN** `bind_address` is configured in agents.toml
- **THEN** gRPC (7400), HTTP (7401), and ReceiverService (9999) all bind to the same address

### Requirement: Safe ServerConfig default
The `ServerConfig::default()` in `notification_config.rs` SHALL default `host` to `"127.0.0.1"` instead of `"0.0.0.0"`.

#### Scenario: Default notification config
- **WHEN** no notification config file exists and no bind_address is passed
- **THEN** `ServerConfig::default().host` returns `"127.0.0.1"`
