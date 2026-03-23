use nexus_core::proto;

// ---------------------------------------------------------------------------
// Telemetry types (side-channel data from CC stream-json)
// ---------------------------------------------------------------------------

/// Rate limit data extracted from `rate_limit_event` lines.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimitData {
    pub utilization: f32,
    pub rate_limit_type: String,
    pub surpassed_threshold: bool,
}

/// Side-channel telemetry that accompanies stream events but is not part of
/// the `CommandOutput` content oneof.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TelemetryUpdate {
    pub rate_limit: Option<RateLimitData>,
    pub cost_usd: Option<f64>,
    pub model: Option<String>,
}

/// Unified parse result: either a `CommandOutput` to forward on the gRPC
/// stream, a telemetry update to persist in the registry, or both.
#[derive(Debug)]
pub enum ParsedEvent {
    /// A regular command output message (text, tool use, tool result, done, error).
    Command(proto::CommandOutput),
    /// Side-channel telemetry (rate limit, cost, model).
    Telemetry(TelemetryUpdate),
    /// Multiple command outputs to forward (e.g. progress + tool_use together).
    CommandBatch(Vec<proto::CommandOutput>),
    /// A batch of command outputs paired with telemetry (e.g. result progress + done + telemetry).
    CommandBatchWithTelemetry(Vec<proto::CommandOutput>, TelemetryUpdate),
}

/// Parse a single line of CC stream-json output.
///
/// CC with `--output-format stream-json --include-partial-messages` emits one JSON object
/// per line. We map each relevant event type to its corresponding `ParsedEvent` variant.
///
/// Returns `None` for lines we don't care about (system messages, metadata, malformed JSON).
pub fn parse_stream_json_line(session_id: &str, line: &str) -> Option<ParsedEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let event_type = v.get("type")?.as_str()?;

    match event_type {
        "assistant" => {
            let content = parse_assistant(&v)?;
            Some(ParsedEvent::Command(proto::CommandOutput {
                session_id: session_id.to_string(),
                content: Some(content),
            }))
        }
        "content_block_delta" => {
            let content = parse_content_block_delta(&v)?;
            Some(ParsedEvent::Command(proto::CommandOutput {
                session_id: session_id.to_string(),
                content: Some(content),
            }))
        }
        "tool_use" => {
            let content = parse_tool_use(&v)?;
            // Emit a progress update alongside the tool_use event so consumers
            // can track which phase (tool) the command is currently executing.
            let tool_name = match &content {
                proto::command_output::Content::ToolUse(info) => info.tool_name.clone(),
                _ => "unknown".to_string(),
            };
            let progress = proto::CommandOutput {
                session_id: session_id.to_string(),
                content: Some(proto::command_output::Content::Progress(
                    proto::ProgressUpdate {
                        phase: tool_name,
                        percent: None,
                        summary: String::new(),
                    },
                )),
            };
            let tool_output = proto::CommandOutput {
                session_id: session_id.to_string(),
                content: Some(content),
            };
            Some(ParsedEvent::CommandBatch(vec![progress, tool_output]))
        }
        "tool_result" => {
            let content = parse_tool_result(&v)?;
            Some(ParsedEvent::Command(proto::CommandOutput {
                session_id: session_id.to_string(),
                content: Some(content),
            }))
        }
        "result" => parse_result_event(session_id, &v),
        "rate_limit_event" => parse_rate_limit_event(&v),
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
                                        Some(ParsedEvent::Command(proto::CommandOutput {
                                            session_id: session_id.to_string(),
                                            content: Some(
                                                proto::command_output::Content::Text(
                                                    proto::TextChunk {
                                                        text: text.to_string(),
                                                        partial: true,
                                                    },
                                                ),
                                            ),
                                        }))
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
    }
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
///
/// Extracts `total_cost_usd` and `model` from the result event when present, returning
/// them as side-channel telemetry alongside the `CommandOutput`.
///
/// Emits a `ProgressUpdate` with a cost/duration summary before the `Done`/`Error` message
/// so consumers can display completion details incrementally.
fn parse_result_event(session_id: &str, v: &serde_json::Value) -> Option<ParsedEvent> {
    // Check for error results first.
    let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);

    let duration = v.get("duration_ms").and_then(|d| d.as_u64()).unwrap_or(0);

    let content = if is_error {
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
        proto::command_output::Content::Error(proto::CommandError {
            message: errors,
            exit_code: 1,
        })
    } else {
        let turns = v.get("num_turns").and_then(|t| t.as_u64()).unwrap_or(0) as u32;
        proto::command_output::Content::Done(proto::CommandDone {
            duration_ms: duration,
            tool_calls: turns,
        })
    };

    // Extract telemetry from the result event.
    let cost_usd = v.get("total_cost_usd").and_then(|c| c.as_f64());
    let model = v
        .get("model")
        .and_then(|m| m.as_str())
        .map(String::from);

    // Build a progress summary for the completion event.
    let summary = {
        let duration_secs = duration as f64 / 1000.0;
        match cost_usd {
            Some(cost) => format!("completed in {duration_secs:.1}s, ${cost:.4}"),
            None => format!("completed in {duration_secs:.1}s"),
        }
    };
    let progress = proto::CommandOutput {
        session_id: session_id.to_string(),
        content: Some(proto::command_output::Content::Progress(
            proto::ProgressUpdate {
                phase: "result".to_string(),
                percent: Some(100.0),
                summary,
            },
        )),
    };

    let output = proto::CommandOutput {
        session_id: session_id.to_string(),
        content: Some(content),
    };

    let batch = vec![progress, output];

    if cost_usd.is_some() || model.is_some() {
        let telemetry = TelemetryUpdate {
            rate_limit: None,
            cost_usd,
            model,
        };
        Some(ParsedEvent::CommandBatchWithTelemetry(batch, telemetry))
    } else {
        Some(ParsedEvent::CommandBatch(batch))
    }
}

/// Parse a `rate_limit_event` into a `Telemetry` variant.
///
/// CC format: `{"type":"rate_limit_event","rate_limit_info":{"utilization":0.91,"rateLimitType":"seven_day","surpassedThreshold":0.75}}`
fn parse_rate_limit_event(v: &serde_json::Value) -> Option<ParsedEvent> {
    let info = v.get("rate_limit_info")?;

    let utilization = info
        .get("utilization")
        .and_then(|u| u.as_f64())
        .unwrap_or(0.0) as f32;

    let rate_limit_type = info
        .get("rateLimitType")
        .and_then(|t| t.as_str())
        .unwrap_or("unknown")
        .to_string();

    // surpassedThreshold can be a float (threshold value) or bool.
    // Treat any non-zero/non-false value as surpassed.
    let surpassed_threshold = info
        .get("surpassedThreshold")
        .map(|s| match s {
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0) > 0.0,
            _ => false,
        })
        .unwrap_or(false);

    Some(ParsedEvent::Telemetry(TelemetryUpdate {
        rate_limit: Some(RateLimitData {
            utilization,
            rate_limit_type,
            surpassed_threshold,
        }),
        cost_usd: None,
        model: None,
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

    /// Helper: extract the CommandOutput from a ParsedEvent, panicking on Telemetry-only.
    /// For batch variants, returns the last non-Progress output.
    fn unwrap_command(event: ParsedEvent) -> proto::CommandOutput {
        match event {
            ParsedEvent::Command(output) => output,
            ParsedEvent::Telemetry(_) => panic!("expected Command, got Telemetry"),
            ParsedEvent::CommandBatch(outputs) => outputs
                .into_iter()
                .rfind(|o| !matches!(&o.content, Some(proto::command_output::Content::Progress(_))))
                .expect("batch contained no non-progress outputs"),
            ParsedEvent::CommandBatchWithTelemetry(outputs, _) => outputs
                .into_iter()
                .rfind(|o| !matches!(&o.content, Some(proto::command_output::Content::Progress(_))))
                .expect("batch contained no non-progress outputs"),
        }
    }

    /// Helper: extract all CommandOutputs from a ParsedEvent batch.
    fn unwrap_batch(event: ParsedEvent) -> Vec<proto::CommandOutput> {
        match event {
            ParsedEvent::Command(output) => vec![output],
            ParsedEvent::CommandBatch(outputs) => outputs,
            ParsedEvent::CommandBatchWithTelemetry(outputs, _) => outputs,
            ParsedEvent::Telemetry(_) => panic!("expected Command/Batch, got Telemetry"),
        }
    }

    #[test]
    fn parse_assistant_message() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}"#;
        let output = unwrap_command(parse_stream_json_line("sess-1", line).unwrap());
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
        let output = unwrap_command(parse_stream_json_line("sess-1", line).unwrap());
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
        let output = unwrap_command(parse_stream_json_line("sess-1", line).unwrap());
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
        let output = unwrap_command(parse_stream_json_line("sess-1", line).unwrap());
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
        let output = unwrap_command(parse_stream_json_line("sess-1", line).unwrap());
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
        let output = unwrap_command(parse_stream_json_line("sess-1", line).unwrap());
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
        let output = unwrap_command(parse_stream_json_line("sess-1", line).unwrap());
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
        let output = unwrap_command(parse_stream_json_line("sess-1", &line).unwrap());
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
        let output = unwrap_command(parse_stream_json_line("sess-1", &line).unwrap());
        match output.content.unwrap() {
            proto::command_output::Content::ToolResult(result) => {
                assert!(result.output_preview.len() <= 510);
                assert!(result.output_preview.ends_with("..."));
            }
            other => panic!("expected ToolResult, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Rate limit event tests (task 2.4)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_rate_limit_event_valid() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"utilization":0.91,"rateLimitType":"seven_day","surpassedThreshold":0.75}}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        match event {
            ParsedEvent::Telemetry(t) => {
                let rl = t.rate_limit.unwrap();
                assert!((rl.utilization - 0.91).abs() < 0.001);
                assert_eq!(rl.rate_limit_type, "seven_day");
                assert!(rl.surpassed_threshold);
            }
            other => panic!("expected Telemetry, got {:?}", other),
        }
    }

    #[test]
    fn parse_rate_limit_event_surpassed_bool_false() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"utilization":0.3,"rateLimitType":"daily","surpassedThreshold":false}}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        match event {
            ParsedEvent::Telemetry(t) => {
                let rl = t.rate_limit.unwrap();
                assert!((rl.utilization - 0.3).abs() < 0.001);
                assert_eq!(rl.rate_limit_type, "daily");
                assert!(!rl.surpassed_threshold);
            }
            other => panic!("expected Telemetry, got {:?}", other),
        }
    }

    #[test]
    fn parse_rate_limit_event_missing_info_returns_none() {
        let line = r#"{"type":"rate_limit_event"}"#;
        assert!(parse_stream_json_line("sess-1", line).is_none());
    }

    #[test]
    fn parse_rate_limit_event_missing_fields_uses_defaults() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{}}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        match event {
            ParsedEvent::Telemetry(t) => {
                let rl = t.rate_limit.unwrap();
                assert!((rl.utilization - 0.0).abs() < 0.001);
                assert_eq!(rl.rate_limit_type, "unknown");
                assert!(!rl.surpassed_threshold);
            }
            other => panic!("expected Telemetry, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Cost/model extraction from result events (task 2.5)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_result_with_cost_and_model() {
        let line = r#"{"type":"result","duration_ms":5000,"num_turns":3,"total_cost_usd":0.42,"model":"claude-opus-4-6"}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        match event {
            ParsedEvent::CommandBatchWithTelemetry(outputs, telemetry) => {
                // First output is the progress update.
                assert!(matches!(
                    &outputs[0].content,
                    Some(proto::command_output::Content::Progress(p)) if p.phase == "result" && p.percent == Some(100.0)
                ));
                // Second output is the Done message.
                match outputs[1].content.as_ref().unwrap() {
                    proto::command_output::Content::Done(done) => {
                        assert_eq!(done.duration_ms, 5000);
                        assert_eq!(done.tool_calls, 3);
                    }
                    other => panic!("expected Done, got {:?}", other),
                }
                assert!((telemetry.cost_usd.unwrap() - 0.42).abs() < 0.001);
                assert_eq!(telemetry.model.as_deref(), Some("claude-opus-4-6"));
                assert!(telemetry.rate_limit.is_none());
            }
            other => panic!("expected CommandBatchWithTelemetry, got {:?}", other),
        }
    }

    #[test]
    fn parse_result_with_zero_cost() {
        let line =
            r#"{"type":"result","duration_ms":100,"num_turns":1,"total_cost_usd":0.0}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        match event {
            ParsedEvent::CommandBatchWithTelemetry(_, telemetry) => {
                assert!((telemetry.cost_usd.unwrap() - 0.0).abs() < 0.001);
                assert!(telemetry.model.is_none());
            }
            other => panic!("expected CommandBatchWithTelemetry, got {:?}", other),
        }
    }

    #[test]
    fn parse_result_without_cost_or_model() {
        let line = r#"{"type":"result","duration_ms":1000,"num_turns":2}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        match event {
            ParsedEvent::CommandBatch(outputs) => {
                assert_eq!(outputs.len(), 2);
                // First is progress, second is Done.
                assert!(matches!(
                    &outputs[0].content,
                    Some(proto::command_output::Content::Progress(_))
                ));
                match outputs[1].content.as_ref().unwrap() {
                    proto::command_output::Content::Done(done) => {
                        assert_eq!(done.duration_ms, 1000);
                        assert_eq!(done.tool_calls, 2);
                    }
                    other => panic!("expected Done, got {:?}", other),
                }
            }
            other => panic!("expected CommandBatch (no telemetry), got {:?}", other),
        }
    }

    #[test]
    fn parse_result_with_model_only() {
        let line =
            r#"{"type":"result","duration_ms":800,"num_turns":1,"model":"claude-sonnet-4-20250514"}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        match event {
            ParsedEvent::CommandBatchWithTelemetry(_, telemetry) => {
                assert!(telemetry.cost_usd.is_none());
                assert_eq!(
                    telemetry.model.as_deref(),
                    Some("claude-sonnet-4-20250514")
                );
            }
            other => panic!("expected CommandBatchWithTelemetry, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Progress event tests (add-command-progress-relay)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_tool_use_emits_progress_and_tool_use() {
        let line =
            r#"{"type":"tool_use","tool":{"name":"Bash","input":{"command":"cargo build"}}}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        let outputs = unwrap_batch(event);
        assert_eq!(outputs.len(), 2);
        // First: ProgressUpdate with phase = tool name.
        match outputs[0].content.as_ref().unwrap() {
            proto::command_output::Content::Progress(p) => {
                assert_eq!(p.phase, "Bash");
                assert!(p.percent.is_none());
                assert!(p.summary.is_empty());
            }
            other => panic!("expected Progress, got {:?}", other),
        }
        // Second: ToolUseInfo.
        match outputs[1].content.as_ref().unwrap() {
            proto::command_output::Content::ToolUse(info) => {
                assert_eq!(info.tool_name, "Bash");
            }
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn parse_result_emits_progress_with_summary() {
        let line = r#"{"type":"result","duration_ms":5000,"num_turns":3,"total_cost_usd":0.42,"model":"claude-opus-4-6"}"#;
        let event = parse_stream_json_line("sess-1", line).unwrap();
        let outputs = unwrap_batch(event);
        assert_eq!(outputs.len(), 2);
        match outputs[0].content.as_ref().unwrap() {
            proto::command_output::Content::Progress(p) => {
                assert_eq!(p.phase, "result");
                assert_eq!(p.percent, Some(100.0));
                assert!(p.summary.contains("5.0s"));
                assert!(p.summary.contains("$0.42"));
            }
            other => panic!("expected Progress, got {:?}", other),
        }
    }
}
