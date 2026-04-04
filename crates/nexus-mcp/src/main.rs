//! nexus-mcp — MCP stdio server for Claude Code integration.
//!
//! Reads line-delimited JSON-RPC 2.0 from stdin, dispatches to tools
//! that proxy nexus-agent HTTP endpoints, writes responses to stdout.
//! Logging goes to stderr via `tracing`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing_subscriber::EnvFilter;

// ── JSON-RPC 2.0 Types ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

// ── MCP Protocol Types ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct McpCapabilities {
    tools: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct McpServerInfo {
    name: String,
    version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpInitializeResult {
    protocol_version: String,
    capabilities: McpCapabilities,
    server_info: McpServerInfo,
}

#[derive(Debug, Serialize)]
struct McpTool {
    name: String,
    description: String,
    #[serde(rename = "inputSchema")]
    input_schema: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct McpToolResult {
    content: Vec<McpToolContent>,
    #[serde(rename = "isError", skip_serializing_if = "std::ops::Not::not")]
    is_error: bool,
}

#[derive(Debug, Serialize)]
struct McpToolContent {
    #[serde(rename = "type")]
    content_type: String,
    text: String,
}

// ── Config ──────────────────────────────────────────────────────────────────

fn agent_base_url() -> String {
    let host = std::env::var("NEXUS_AGENT_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("NEXUS_AGENT_PORT")
        .unwrap_or_else(|_| format!("{}", nexus_core::DEFAULT_HTTP_PORT));
    format!("http://{}:{}", host, port)
}

// ── Tool Definitions ────────────────────────────────────────────────────────

fn tool_definitions() -> Vec<McpTool> {
    vec![
        McpTool {
            name: "get_credential_status".to_string(),
            description: "Get the current credential pool status including active account, \
                          utilization, and rate limit windows. No sensitive data (tokens/paths) \
                          is exposed."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "get_sessions".to_string(),
            description: "Get active Claude Code sessions across all machines, including \
                          project, status, model, and idle time."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "get_recommendations".to_string(),
            description: "Get scored work recommendations based on beads issues, project \
                          context, and failure spikes."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "get_all_specs".to_string(),
            description: "Get aggregated openspec and beads status across all registered \
                          projects. Returns spec snapshots (name, status, task progress) \
                          and beads summary (open, closed, ready) for every project."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "get_pending_specs".to_string(),
            description: "Get all specs pending review (unread or read status). Shows which \
                          proposals need approval before they can be applied."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
        McpTool {
            name: "approve_spec".to_string(),
            description: "Approve a spec for implementation. The spec must be in 'read' or \
                          'unread' status."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project code (e.g., 'oo', 'nx')"
                    },
                    "name": {
                        "type": "string",
                        "description": "Spec name (e.g., 'add-user-auth')"
                    }
                },
                "required": ["project", "name"]
            }),
        },
        McpTool {
            name: "reject_spec".to_string(),
            description: "Reject a spec. The spec must be in 'read' or 'unread' status."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project code (e.g., 'oo', 'nx')"
                    },
                    "name": {
                        "type": "string",
                        "description": "Spec name (e.g., 'add-user-auth')"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Optional rejection reason"
                    }
                },
                "required": ["project", "name"]
            }),
        },
        McpTool {
            name: "apply_spec".to_string(),
            description: "Check whether a spec is approved for implementation. Returns success \
                          if the spec has 'approved' status, or an error if it is not yet \
                          approved. Use this before running /apply to enforce the Nexus \
                          approval gate.".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project code (e.g., 'oo', 'nx')"
                    },
                    "name": {
                        "type": "string",
                        "description": "Spec name (e.g., 'add-user-auth')"
                    }
                },
                "required": ["project", "name"]
            }),
        },
        McpTool {
            name: "get_health_history".to_string(),
            description: "Get historical health metrics (CPU, memory, disk, load) sampled \
                          every 30 seconds. Returns timeseries data for charting."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "hours": {
                        "type": "integer",
                        "description": "Number of hours of history to return (default: 24)"
                    }
                },
                "required": []
            }),
        },
        McpTool {
            name: "get_credential_history".to_string(),
            description: "Get historical credential usage polls and swap events. Shows \
                          utilization trends and rotation history."
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "hours": {
                        "type": "integer",
                        "description": "Number of hours of history to return (default: 24)"
                    }
                },
                "required": []
            }),
        },
    ]
}

// ── Tool Execution ──────────────────────────────────────────────────────────

async fn execute_tool(
    name: &str,
    arguments: &serde_json::Value,
    client: &reqwest::Client,
) -> McpToolResult {
    let base_url = agent_base_url();

    // Build the request based on the tool name.
    let request = match name {
        "get_credential_status" => client.get(format!("{}/credentials", base_url)),
        "get_sessions" => client.get(format!("{}/statusline", base_url)),
        "get_recommendations" => client.get(format!("{}/recommend", base_url)),
        "get_all_specs" => client.get(format!("{}/specs/all", base_url)),
        "get_pending_specs" => client.get(format!("{}/specs?status=unread,read", base_url)),
        "approve_spec" => {
            let project = arguments
                .get("project")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let name_arg = arguments.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if project.is_empty() || name_arg.is_empty() {
                return McpToolResult {
                    content: vec![McpToolContent {
                        content_type: "text".to_string(),
                        text: "Missing required parameters: project and name".to_string(),
                    }],
                    is_error: true,
                };
            }
            client.post(format!(
                "{}/specs/{}/{}/approve",
                base_url, project, name_arg
            ))
        }
        "reject_spec" => {
            let project = arguments
                .get("project")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let name_arg = arguments.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if project.is_empty() || name_arg.is_empty() {
                return McpToolResult {
                    content: vec![McpToolContent {
                        content_type: "text".to_string(),
                        text: "Missing required parameters: project and name".to_string(),
                    }],
                    is_error: true,
                };
            }
            let reason = arguments.get("reason").and_then(|v| v.as_str());
            let body = serde_json::json!({ "reason": reason });
            client
                .post(format!(
                    "{}/specs/{}/{}/reject",
                    base_url, project, name_arg
                ))
                .json(&body)
        }
        "apply_spec" => {
            let project = arguments.get("project").and_then(|v| v.as_str()).unwrap_or("");
            let name_arg = arguments.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if project.is_empty() || name_arg.is_empty() {
                return McpToolResult {
                    content: vec![McpToolContent {
                        content_type: "text".to_string(),
                        text: "Missing required parameters: project and name".to_string(),
                    }],
                    is_error: true,
                };
            }
            // Query the approval gate endpoint
            let url = format!("{}/specs/{}/{}/status", base_url, project, name_arg);
            let resp = client.get(&url).send().await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let body: serde_json::Value = r.json().await.unwrap_or_default();
                    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                    if status == "approved" {
                        return McpToolResult {
                            content: vec![McpToolContent {
                                content_type: "text".to_string(),
                                text: format!("Spec {}/{} is approved. Proceed with /apply.", project, name_arg),
                            }],
                            is_error: false,
                        };
                    } else {
                        return McpToolResult {
                            content: vec![McpToolContent {
                                content_type: "text".to_string(),
                                text: format!(
                                    "Spec {}/{} is not approved (status: {}). Review and approve in Nexus TUI or call approve_spec first.",
                                    project, name_arg, status
                                ),
                            }],
                            is_error: true,
                        };
                    }
                }
                Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
                    return McpToolResult {
                        content: vec![McpToolContent {
                            content_type: "text".to_string(),
                            text: format!(
                                "Spec {}/{} not found in Nexus. Agent may not have polled yet.",
                                project, name_arg
                            ),
                        }],
                        is_error: true,
                    };
                }
                Ok(r) => {
                    return McpToolResult {
                        content: vec![McpToolContent {
                            content_type: "text".to_string(),
                            text: format!("Unexpected response from agent: {}", r.status()),
                        }],
                        is_error: true,
                    };
                }
                Err(e) => {
                    return McpToolResult {
                        content: vec![McpToolContent {
                            content_type: "text".to_string(),
                            text: format!("Nexus agent unreachable: {}", e),
                        }],
                        is_error: true,
                    };
                }
            }
        }
        "get_health_history" => {
            let hours = arguments
                .get("hours")
                .and_then(|v| v.as_u64())
                .unwrap_or(24);
            client.get(format!("{}/analytics/health?hours={}", base_url, hours))
        }
        "get_credential_history" => {
            let hours = arguments
                .get("hours")
                .and_then(|v| v.as_u64())
                .unwrap_or(24);
            client.get(format!(
                "{}/analytics/credentials?hours={}",
                base_url, hours
            ))
        }
        _ => {
            return McpToolResult {
                content: vec![McpToolContent {
                    content_type: "text".to_string(),
                    text: format!("Unknown tool: {}", name),
                }],
                is_error: true,
            };
        }
    };

    match request.send().await {
        Ok(resp) => {
            if resp.status().is_success() {
                match resp.text().await {
                    Ok(body) => McpToolResult {
                        content: vec![McpToolContent {
                            content_type: "text".to_string(),
                            text: body,
                        }],
                        is_error: false,
                    },
                    Err(e) => McpToolResult {
                        content: vec![McpToolContent {
                            content_type: "text".to_string(),
                            text: format!("Failed to read response body: {}", e),
                        }],
                        is_error: true,
                    },
                }
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                McpToolResult {
                    content: vec![McpToolContent {
                        content_type: "text".to_string(),
                        text: format!("Agent returned HTTP {}: {}", status, body),
                    }],
                    is_error: true,
                }
            }
        }
        Err(e) => McpToolResult {
            content: vec![McpToolContent {
                content_type: "text".to_string(),
                text: format!(
                    "Cannot reach nexus-agent at {}. Is the agent running? Error: {}",
                    base_url, e
                ),
            }],
            is_error: true,
        },
    }
}

// ── Request Dispatch ────────────────────────────────────────────────────────

async fn dispatch(req: &JsonRpcRequest, client: &reqwest::Client) -> JsonRpcResponse {
    match req.method.as_str() {
        "initialize" => {
            let mut tools_cap = HashMap::new();
            tools_cap.insert("listChanged".to_string(), serde_json::json!(false));

            let result = McpInitializeResult {
                protocol_version: "2024-11-05".to_string(),
                capabilities: McpCapabilities { tools: tools_cap },
                server_info: McpServerInfo {
                    name: "nexus-mcp".to_string(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                },
            };

            JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: req.id.clone(),
                result: Some(serde_json::to_value(result).unwrap()),
                error: None,
            }
        }

        "notifications/initialized" => {
            // Client acknowledgement — no response needed for notifications.
            // Return empty response since we process all messages uniformly.
            JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: req.id.clone(),
                result: Some(serde_json::json!({})),
                error: None,
            }
        }

        "tools/list" => {
            let tools = tool_definitions();
            JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: req.id.clone(),
                result: Some(serde_json::json!({ "tools": tools })),
                error: None,
            }
        }

        "tools/call" => {
            let tool_name = req
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let arguments = req
                .params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));

            let tool_result = execute_tool(tool_name, &arguments, client).await;

            JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: req.id.clone(),
                result: Some(serde_json::to_value(tool_result).unwrap()),
                error: None,
            }
        }

        _ => JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: req.id.clone(),
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("Method not found: {}", req.method),
                data: None,
            }),
        },
    }
}

// ── Main Loop ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // Sentry must be initialized before any other setup — _guard keeps it alive
    let _sentry_guard = {
        let dsn = std::env::var("SENTRY_DSN").unwrap_or_default();
        sentry::init((
            dsn.as_str(),
            sentry::ClientOptions {
                release: sentry::release_name!(),
                environment: std::env::var("SENTRY_ENVIRONMENT")
                    .ok()
                    .map(|s| s.into()),
                ..Default::default()
            },
        ))
    };

    // Tracing goes to stderr so stdout is reserved for JSON-RPC.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("nexus_mcp=info".parse().unwrap()),
        )
        .with_writer(std::io::stderr)
        .init();

    tracing::info!("nexus-mcp starting (base_url={})", agent_base_url());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("failed to create reqwest client");

    let stdin = tokio::io::stdin();
    let reader = BufReader::new(stdin);
    let mut lines = reader.lines();

    let mut stdout = std::io::stdout().lock();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let req: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: None,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32700,
                        message: format!("Parse error: {}", e),
                        data: None,
                    }),
                };
                let _ = serde_json::to_writer(&mut stdout, &err_resp);
                let _ = writeln!(stdout);
                let _ = stdout.flush();
                continue;
            }
        };

        // Notifications (no id) don't get responses in JSON-RPC 2.0,
        // but MCP expects responses for all named methods, so we respond.
        let resp = dispatch(&req, &client).await;

        // Only write response if request had an id (JSON-RPC 2.0 spec).
        if req.id.is_some() {
            let _ = serde_json::to_writer(&mut stdout, &resp);
            let _ = writeln!(stdout);
            let _ = stdout.flush();
        }
    }

    tracing::info!("nexus-mcp shutting down (stdin closed)");
}
