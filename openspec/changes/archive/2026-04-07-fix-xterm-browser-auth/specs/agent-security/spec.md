## ADDED Requirements

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
