use nexus_core::proto;

/// Parse a single line of CC stream-json output into a CommandOutput proto message.
///
/// CC with `--output-format stream-json --include-partial-messages` emits one JSON object
/// per line. We map each relevant event type to its corresponding `CommandOutput` variant.
///
/// Returns `None` for lines we don't care about (system messages, metadata, malformed JSON).
pub fn parse_stream_json_line(session_id: &str, line: &str) -> Option<proto::CommandOutput> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let event_type = v.get("type")?.as_str()?;

    let content = match event_type {
        "assistant" => parse_assistant(&v),
        "content_block_delta" => parse_content_block_delta(&v),
        "tool_use" => parse_tool_use(&v),
        "tool_result" => parse_tool_result(&v),
        "result" => parse_result(&v),
        // stream_event wraps inner events — unwrap and parse the inner event.
        "stream_event" => {
            if let Some(inner) = v.get("event") {
                let inner_type = inner.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match inner_type {
                    "content_block_delta" => {
                        // Unwrap: delta is inside event.delta
                        if let Some(delta) = inner.get("delta") {
                            let delta_type =
                                delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            match delta_type {
                                "text_delta" => {
                                    let text =
                                        delta.get("text").and_then(|t| t.as_str()).unwrap_or("");
                                    if text.is_empty() {
                                        None
                                    } else {
                                        Some(proto::command_output::Content::Text(
                                            proto::TextChunk {
                                                text: text.to_string(),
                                                partial: true,
                                            },
                                        ))
                                    }
                                }
                                _ => None, // input_json_delta, thinking_delta etc — skip
                            }
                        } else {
                            None
                        }
                    }
                    _ => None, // message_start, message_stop, etc — skip
                }
            } else {
                None
            }
        }
        _ => None,
    };

    content.map(|c| proto::CommandOutput {
        session_id: session_id.to_string(),
        content: Some(c),
    })
}

/// Full assistant message: extract text from the content array.
fn parse_assistant(v: &serde_json::Value) -> Option<proto::command_output::Content> {
    // CC format: {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
    // Content array may have multiple blocks; concatenate all text blocks.
    let content_array = v.pointer("/message/content")?.as_array()?;

    let text: String = content_array
        .iter()
        .filter_map(|block| {
            let block_type = block.get("type")?.as_str()?;
            if block_type == "text" {
                block.get("text")?.as_str().map(String::from)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("");

    if text.is_empty() {
        return None;
    }

    Some(proto::command_output::Content::Text(proto::TextChunk {
        text,
        partial: false,
    }))
}

/// Streaming partial text delta.
fn parse_content_block_delta(v: &serde_json::Value) -> Option<proto::command_output::Content> {
    // CC format: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}
    let text = v
        .pointer("/delta/text")
        .and_then(|t| t.as_str())
        .unwrap_or("");

    if text.is_empty() {
        return None;
    }

    Some(proto::command_output::Content::Text(proto::TextChunk {
        text: text.to_string(),
        partial: true,
    }))
}

/// Tool invocation event. Handles both CC formats:
/// - `{"type":"tool_use","tool":{"name":"Bash","input":{...}}}` (observed in design doc)
/// - `{"type":"tool_use","name":"Bash","input":{...}}` (flat variant)
fn parse_tool_use(v: &serde_json::Value) -> Option<proto::command_output::Content> {
    // Try nested "tool" object first (design doc format), then flat keys.
    let tool_obj = v.get("tool");

    let name = tool_obj
        .and_then(|t| t.get("name"))
        .or_else(|| v.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("unknown");

    let input = tool_obj
        .and_then(|t| t.get("input"))
        .or_else(|| v.get("input"))
        .map(|i| truncate_json(i, 200))
        .unwrap_or_default();

    Some(proto::command_output::Content::ToolUse(
        proto::ToolUseInfo {
            tool_name: name.to_string(),
            input_preview: input,
        },
    ))
}

/// Tool result event. Handles both CC formats:
/// - `{"type":"tool_result","tool":{"name":"Bash"},"content":"output here"}` (design doc)
/// - `{"type":"tool_result","tool_use_id":"...","content":"output","is_error":false}` (flat)
fn parse_tool_result(v: &serde_json::Value) -> Option<proto::command_output::Content> {
    let tool_obj = v.get("tool");

    let name = tool_obj
        .and_then(|t| t.get("name"))
        .or_else(|| v.get("tool_name"))
        .or_else(|| v.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("unknown");

    // Content can be a string or a complex object; coerce to string preview.
    let output = v
        .get("content")
        .map(|c| match c.as_str() {
            Some(s) => s.to_string(),
            None => c.to_string(),
        })
        .unwrap_or_default();

    let output_preview = truncate_string(&output, 500);

    let success = !v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);

    Some(proto::command_output::Content::ToolResult(
        proto::ToolResult {
            tool_name: name.to_string(),
            output_preview,
            success,
        },
    ))
}

/// Final result event indicating the command is complete.
/// Also handles error results: `{"type":"result","subtype":"error_during_execution","errors":[...]}`
fn parse_result(v: &serde_json::Value) -> Option<proto::command_output::Content> {
    // Check for error results first.
    let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);

    if is_error {
        let errors = v
            .get("errors")
            .and_then(|e| e.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_else(|| "unknown error".to_string());
        return Some(proto::command_output::Content::Error(proto::CommandError {
            message: errors,
            exit_code: 1,
        }));
    }

    let duration = v.get("duration_ms").and_then(|d| d.as_u64()).unwrap_or(0);

    let turns = v.get("num_turns").and_then(|t| t.as_u64()).unwrap_or(0) as u32;

    Some(proto::command_output::Content::Done(proto::CommandDone {
        duration_ms: duration,
        tool_calls: turns,
    }))
}

/// Truncate a JSON value's string representation, appending "..." if truncated.
fn truncate_json(value: &serde_json::Value, max_len: usize) -> String {
    let s = value.to_string();
    truncate_string(&s, max_len)
}

/// Truncate a string at a char boundary, appending "..." if truncated.
fn truncate_string(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        return s.to_string();
    }
    // Find a valid char boundary at or before max_len.
    let boundary = s
        .char_indices()
        .take_while(|&(i, _)| i <= max_len)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    format!("{}...", &s[..boundary])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_assistant_message() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}"#;
        let output = parse_stream_json_line("sess-1", line).unwrap();
        assert_eq!(output.session_id, "sess-1");
        match output.content.unwrap() {
            proto::command_output::Content::Text(chunk) => {
                assert_eq!(chunk.text, "Hello world");
                assert!(!chunk.partial);
            }
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn parse_assistant_empty_text_returns_none() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":""}]}}"#;
        assert!(parse_stream_json_line("sess-1", line).is_none());
    }

    #[test]
    fn parse_content_block_delta() {
        let line = r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial output"}}"#;
        let output = parse_stream_json_line("sess-1", line).unwrap();
        match output.content.unwrap() {
            proto::command_output::Content::Text(chunk) => {
                assert_eq!(chunk.text, "partial output");
                assert!(chunk.partial);
            }
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn parse_tool_use_nested_format() {
        let line =
            r#"{"type":"tool_use","tool":{"name":"Bash","input":{"command":"cargo build"}}}"#;
        let output = parse_stream_json_line("sess-1", line).unwrap();
        match output.content.unwrap() {
            proto::command_output::Content::ToolUse(info) => {
                assert_eq!(info.tool_name, "Bash");
                assert!(info.input_preview.contains("cargo build"));
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn parse_tool_use_flat_format() {
        let line = r#"{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/test.rs"}}"#;
        let output = parse_stream_json_line("sess-1", line).unwrap();
        match output.content.unwrap() {
            proto::command_output::Content::ToolUse(info) => {
                assert_eq!(info.tool_name, "Read");
                assert!(info.input_preview.contains("/tmp/test.rs"));
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn parse_tool_result_with_content_string() {
        let line = r#"{"type":"tool_result","tool":{"name":"Bash"},"content":"Build succeeded","is_error":false}"#;
        let output = parse_stream_json_line("sess-1", line).unwrap();
        match output.content.unwrap() {
            proto::command_output::Content::ToolResult(result) => {
                assert_eq!(result.tool_name, "Bash");
                assert_eq!(result.output_preview, "Build succeeded");
                assert!(result.success);
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn parse_tool_result_error() {
        let line = r#"{"type":"tool_result","tool":{"name":"Bash"},"content":"command not found","is_error":true}"#;
        let output = parse_stream_json_line("sess-1", line).unwrap();
        match output.content.unwrap() {
            proto::command_output::Content::ToolResult(result) => {
                assert!(!result.success);
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn parse_result_done() {
        let line = r#"{"type":"result","result":"Final message","duration_ms":3200,"num_turns":5}"#;
        let output = parse_stream_json_line("sess-1", line).unwrap();
        match output.content.unwrap() {
            proto::command_output::Content::Done(done) => {
                assert_eq!(done.duration_ms, 3200);
                assert_eq!(done.tool_calls, 5);
            }
            other => panic!("expected Done, got {:?}", other),
        }
    }

    #[test]
    fn parse_unknown_type_returns_none() {
        let line = r#"{"type":"system","message":"initializing"}"#;
        assert!(parse_stream_json_line("sess-1", line).is_none());
    }

    #[test]
    fn parse_invalid_json_returns_none() {
        assert!(parse_stream_json_line("sess-1", "not json at all").is_none());
    }

    #[test]
    fn parse_empty_line_returns_none() {
        assert!(parse_stream_json_line("sess-1", "").is_none());
        assert!(parse_stream_json_line("sess-1", "  ").is_none());
    }

    #[test]
    fn truncate_long_tool_input() {
        let long_input = "x".repeat(300);
        let line = format!(
            r#"{{"type":"tool_use","name":"Write","input":{{"content":"{}"}}}}"#,
            long_input
        );
        let output = parse_stream_json_line("sess-1", &line).unwrap();
        match output.content.unwrap() {
            proto::command_output::Content::ToolUse(info) => {
                // 200 chars + "..." suffix
                assert!(info.input_preview.len() <= 210);
                assert!(info.input_preview.ends_with("..."));
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn truncate_long_tool_result_output() {
        let long_output = "y".repeat(600);
        let line = format!(
            r#"{{"type":"tool_result","tool":{{"name":"Bash"}},"content":"{}"}}"#,
            long_output
        );
        let output = parse_stream_json_line("sess-1", &line).unwrap();
        match output.content.unwrap() {
            proto::command_output::Content::ToolResult(result) => {
                assert!(result.output_preview.len() <= 510);
                assert!(result.output_preview.ends_with("..."));
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }
}
