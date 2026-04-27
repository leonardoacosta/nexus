# agent-security Specification

## Purpose
TBD - created by archiving change secure-agent-endpoints. Update Purpose after archive.
## Requirements
### Requirement: Configurable Bind Address
The agent SHALL read `bind_address` from `agents.toml` configuration and bind both HTTP and gRPC servers to the specified address. The default bind address SHALL be `127.0.0.1` (localhost only).

#### Scenario: Default bind to localhost
- **WHEN** no `bind_address` is configured in agents.toml
- **THEN** both HTTP (7401) and gRPC (7400) servers bind to `127.0.0.1`

#### Scenario: Explicit bind address configured
- **WHEN** `bind_address = "0.0.0.0"` is set in agents.toml
- **THEN** both servers bind to `0.0.0.0` as specified

### Requirement: CORS Allows Auth Header for Browser Clients
The CORS middleware SHALL include `x-nexus-secret` in the `Access-Control-Allow-Headers`
response header so that browser clients hosted at a Tailscale origin can include the auth
header in cross-origin requests. The `Access-Control-Allow-Origin` header SHALL continue to be
scoped to Tailscale origins (`100.x.x.x`) only.

#### Scenario: Browser preflight from Tailscale origin
- **WHEN** an OPTIONS preflight request arrives with an `Origin` header matching `100.x.x.x`
- **THEN** the response includes `Access-Control-Allow-Headers: Content-Type, x-nexus-secret`

#### Scenario: Non-Tailscale origin receives no CORS headers
- **WHEN** a request arrives with an `Origin` that does not match `100.x.x.x`
- **THEN** no `Access-Control-Allow-*` headers are set in the response

### Requirement: Interact WebSocket Write Guard
The WebSocket `message` handler SHALL verify that the sending socket holds the writer lock
via `streamManager.isWriter(ws)` before processing any input. Messages from sockets that do
not hold the writer lock SHALL be silently dropped without writing to the PTY. This enforces
the existing exclusive-writer contract at the message-processing layer.

#### Scenario: Writer socket sends input
- **WHEN** a WebSocket in `interact` mode that holds the writer lock sends a binary or text message
- **THEN** the message is forwarded to the PTY normally

#### Scenario: Non-writer socket sends input
- **WHEN** a WebSocket in `interact` mode that does not hold the writer lock sends a message
- **THEN** the message is silently dropped and no PTY write occurs

### Requirement: Credential ID URL Parameter Sanitization
The agent SHALL validate credential ID path parameters against the pattern
`[a-zA-Z0-9_-]+` before using them in log statements, error responses, or downstream calls.
Requests with IDs that fail validation SHALL be rejected with HTTP 400 Bad Request. This
prevents log injection and reflected-content attacks via crafted credential IDs.

#### Scenario: Valid credential ID in release path
- **WHEN** a request to `POST /credentials/my-cred-01/release` is received
- **THEN** the ID passes validation and the release handler is invoked

#### Scenario: Invalid credential ID rejected
- **WHEN** a request to `POST /credentials/../etc/passwd/release` or an ID containing spaces or HTML characters is received
- **THEN** the server responds with HTTP 400 Bad Request before calling any handler

### Requirement: WebSocket Query-String Token Authentication
The agent WebSocket upgrade handler SHALL accept the shared secret from the `token`
query-string parameter as an alternative to the `x-nexus-secret` header. The token
SHALL be validated using a constant-time comparison (`crypto.timingSafeEqual`) before
the upgrade proceeds. A missing or incorrect token SHALL result in HTTP 401 with the
upgrade rejected. This mechanism exists because the browser `WebSocket` API cannot set
custom headers; header-based auth remains the preferred path for non-browser callers.

#### Scenario: Browser connects with correct query-string token
- **WHEN** a browser initiates a WebSocket connection to `/sessions/:id/stream` or
  `/sessions/:id/interact` with `?token=<valid-secret>` in the URL and no
  `x-nexus-secret` header
- **THEN** the upgrade succeeds and the connection is established

#### Scenario: Missing token and missing header
- **WHEN** a WebSocket upgrade request arrives with neither `x-nexus-secret` header nor
  `?token=` query parameter
- **THEN** the server responds HTTP 401 and the upgrade is rejected

#### Scenario: Incorrect query-string token
- **WHEN** a WebSocket upgrade request arrives with `?token=wrong-value` and no header
- **THEN** the server responds HTTP 401 and the upgrade is rejected

#### Scenario: Header takes precedence when both present
- **WHEN** a WebSocket upgrade request arrives with both a valid `x-nexus-secret` header
  and a `?token=` parameter (valid or invalid)
- **THEN** authentication succeeds based on the header value; the query-string token is
  ignored

### Requirement: updateCommand REST Endpoint Authentication
The `AgentClient.updateCommand()` method in the Next.js app SHALL include the
`x-nexus-secret` header on every `PUT /commands/:name` request, consistent with all
other methods in the file.

#### Scenario: updateCommand includes auth header
- **WHEN** `AgentClient.updateCommand()` is called with valid arguments
- **THEN** the outgoing PUT request includes `x-nexus-secret: <secret>` in its headers

#### Scenario: Agent rejects updateCommand without auth header
- **WHEN** a `PUT /commands/:name` request arrives without `x-nexus-secret`
- **THEN** the agent responds HTTP 401

### Requirement: PTY Spawned Process Env Isolation
`NodePtySource` SHALL NOT expose known-sensitive environment variables to PTY child
processes. Before spawning, `NodePtySource` SHALL strip the following keys from the
inherited `process.env`: `NEXUS_ATTACH_SECRET`, `NEXUS_ENCRYPTION_KEY`, `POSTGRES_URL`,
`DATABASE_URL`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`. When a caller explicitly passes
`opts.env`, that value SHALL be used as-is without stripping.

#### Scenario: Default env hides secrets from interactive shell
- **WHEN** a PTY session is spawned without an explicit `opts.env`
- **THEN** the child shell does not have `NEXUS_ATTACH_SECRET` or `NEXUS_ENCRYPTION_KEY`
  in its environment (verified via `env` output)

#### Scenario: Explicit caller env bypasses stripping
- **WHEN** a PTY session is spawned with an explicit `opts.env` that includes a secret
  key
- **THEN** that env is passed to the child unchanged (caller takes responsibility)

#### Scenario: Shell remains functional after stripping
- **WHEN** a PTY session is spawned without `opts.env`
- **THEN** `PATH`, `HOME`, `TERM`, `LANG`, and `USER` are present in the child
  environment

### Requirement: State Directory Permission Hardening

The system SHALL create the `~/.config/nexus/state/` directory with
permissions `0o700` (owner read/write/execute only). When the directory is
created via `create_dir_all`, the system MUST explicitly call
`set_permissions` to enforce `0o700` regardless of the process umask. This
prevents other local users from listing directory contents and discovering
usage-data filenames.

#### Scenario: State directory created with restricted permissions

- **WHEN** the agent creates `~/.config/nexus/state/` for the first time
- **THEN** the directory permissions are `0o700` (drwx------)

#### Scenario: Existing state directory permissions corrected

- **WHEN** the agent starts and `~/.config/nexus/state/` already exists with
  permissions more permissive than `0o700`
- **THEN** the agent tightens permissions to `0o700` before writing any state
  files

### Requirement: Agent binds to loopback and Tailscale interface by default

When `bind_address` is unset or set to `"0.0.0.0"` in `agents.toml`, the agent SHALL bind its HTTP server to two addresses simultaneously: `127.0.0.1` (loopback) and the Tailscale interface IP discovered via `tailscale ip -4` at boot. Random LAN clients on other interfaces SHALL NOT reach the agent. An explicit `bind_address` value other than `"0.0.0.0"` SHALL be honored verbatim and SHALL NOT trigger the multi-bind default.

#### Scenario: Default bind to loopback plus Tailscale

- **GIVEN** `bind_address` is not set in `agents.toml` (or set to `"0.0.0.0"`)
- **AND** the host has a `tailscale0` interface with IP `100.73.182.4`
- **WHEN** the agent starts
- **THEN** `curl http://127.0.0.1:7400/health` SHALL return 200
- **AND** `curl http://100.73.182.4:7400/health` SHALL return 200
- **AND** a request from a non-loopback non-Tailscale interface (e.g. a `192.168.1.x` LAN address) SHALL fail to connect

#### Scenario: Tailscale unavailable degrades to loopback-only

- **GIVEN** `tailscale ip -4` exits non-zero (Tailscale not installed, daemon down, or no network)
- **WHEN** the agent starts
- **THEN** the agent SHALL bind to `127.0.0.1` only
- **AND** SHALL log a warning naming the missed Tailscale binding
- **AND** SHALL NOT exit with an error (loopback-only is a valid degraded mode)

#### Scenario: Explicit bind override is honored without the Tailscale fallback

- **GIVEN** `agents.toml` contains `bind_address = "127.0.0.1"`
- **WHEN** the agent starts
- **THEN** the agent SHALL bind ONLY to `127.0.0.1`
- **AND** SHALL NOT additionally bind to Tailscale
- **AND** SHALL NOT shell out to `tailscale ip -4` at all

