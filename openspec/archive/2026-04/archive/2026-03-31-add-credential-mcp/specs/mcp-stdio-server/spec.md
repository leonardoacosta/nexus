# Capability: MCP Stdio Server

## ADDED Requirements

### Requirement: The system SHALL provide an MCP stdio server binary

The `nexus-mcp` binary SHALL read JSON-RPC 2.0 messages from stdin and write responses to stdout.
It MUST handle `initialize` (returns server info and capabilities), `tools/list` (returns 3 tool
definitions), and `tools/call` (dispatches to the appropriate tool handler). Unrecognized methods
MUST return JSON-RPC error code -32601 (method not found). Logging SHALL go to stderr via tracing.

#### Scenario: Initialize handshake
Given nexus-mcp is started
When the client sends `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`
Then the response includes `serverInfo.name: "nexus-mcp"` and `capabilities.tools: {}`

#### Scenario: List tools
Given nexus-mcp is initialized
When the client sends `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`
Then the response includes 3 tools: `get_credential_status`, `get_sessions`, `get_recommendations`

#### Scenario: Call get_credential_status with agent running
Given nexus-agent is running on 127.0.0.1:7401
When the client sends `tools/call` with `name: "get_credential_status"`
Then the response content contains the JSON from `GET /credentials`

#### Scenario: Call tool with agent unreachable
Given nexus-agent is not running
When the client sends `tools/call` with any tool name
Then the response `isError` is true and content describes the connection failure

### Requirement: The system SHALL support environment variable configuration

The binary SHALL read the agent host from `NEXUS_AGENT_HOST` (default `127.0.0.1`) and port from
`NEXUS_AGENT_PORT` (default `7401`).

#### Scenario: Custom agent address
Given `NEXUS_AGENT_HOST=10.0.0.5` and `NEXUS_AGENT_PORT=8080`
When any MCP tool is called
Then the HTTP request targets `http://10.0.0.5:8080/...`
