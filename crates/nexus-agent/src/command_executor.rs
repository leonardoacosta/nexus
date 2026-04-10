//! Shared subprocess execution logic for spawning `claude -p` with
//! `--output-format stream-json` and forwarding parsed output over an mpsc
//! channel.
//!
//! Callers follow the same pattern:
//!
//! 1. Build a `tokio::process::Command` for `claude -p`
//! 2. Spawn it with piped stdout/stderr
//! 3. Read stdout line-by-line, parse each line via `parser::parse_stream_json_line`
//! 4. Update session telemetry as a side-channel
//! 5. Forward `CommandOutput` messages on an mpsc sender
//! 6. Wait for process exit and synthesize a `CommandDone` if the parser
//!    didn't emit one
//!
//! This module extracts that logic into a single reusable function so callers
//! only need to build the `Command` and supply an optional post-completion
//! callback.

use std::sync::Arc;

use nexus_core::proto;

use crate::registry::SessionRegistry;

/// Execute a pre-built `claude` subprocess and forward parsed output.
///
/// # Arguments
///
/// * `cmd` — a fully configured `tokio::process::Command` (args, env, cwd set
///   by the caller); stdout and stderr are piped inside this function.
/// * `session_id` — the nexus session ID used for telemetry updates and log
///   context.
/// * `registry` — shared session registry for `update_telemetry` side-channel.
/// * `tx` — mpsc sender; each parsed `CommandOutput` (and the synthetic
///   `CommandDone` at the end) is sent here.
/// * `on_exit` — an optional async callback invoked after the subprocess
///   finishes (success *and* failure). Use this to release pool sessions or
///   perform other cleanup. The callback receives no arguments and its return
///   value is ignored.
///
/// The function is intended to be called from inside `tokio::spawn`.
pub async fn run_claude_subprocess<F, Fut>(
    mut cmd: tokio::process::Command,
    session_id: String,
    registry: Arc<SessionRegistry>,
    tx: tokio::sync::mpsc::Sender<Result<proto::CommandOutput, String>>,
    on_exit: Option<F>,
) where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let sid = session_id;

    // Pipe stdout and stderr so we can read them.
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child = cmd.spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("failed to spawn claude process: {e}");
            tracing::error!(session_id = %sid, "{}", msg);
            let _ = tx
                .send(Ok(proto::CommandOutput {
                    session_id: sid,
                    content: Some(proto::command_output::Content::Error(proto::CommandError {
                        message: msg,
                        exit_code: -1,
                    })),
                }))
                .await;
            if let Some(cb) = on_exit {
                cb().await;
            }
            return;
        }
    };

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let reader = tokio::io::BufReader::new(stdout);
    let mut lines = tokio::io::AsyncBufReadExt::lines(reader);

    // Drain stderr in a background task so it never blocks the stdout reader.
    let stderr_handle = tokio::spawn(async move {
        let mut stderr_reader = tokio::io::BufReader::new(stderr);
        let mut stderr_buf = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr_reader, &mut stderr_buf).await;
        stderr_buf
    });

    let mut done_sent = false;

    // Read stdout line-by-line and forward parsed events.
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                tracing::info!(
                    session_id = %sid,
                    "stream-json line: {}",
                    &line[..line.len().min(200)]
                );

                if let Some(event) = crate::parser::parse_stream_json_line(&sid, &line) {
                    match event {
                        crate::parser::ParsedEvent::Telemetry(telemetry) => {
                            // Side-channel telemetry -- persist but don't forward.
                            registry.update_telemetry(&sid, &telemetry).await;
                        }
                        crate::parser::ParsedEvent::Command(output) => {
                            if matches!(
                                &output.content,
                                Some(proto::command_output::Content::Done(_))
                            ) {
                                done_sent = true;
                            }
                            if tx.send(Ok(output)).await.is_err() {
                                tracing::debug!(
                                    session_id = %sid,
                                    "run_claude_subprocess: client disconnected"
                                );
                                let _ = child.kill().await;
                                if let Some(cb) = on_exit {
                                    cb().await;
                                }
                                return;
                            }
                        }
                        crate::parser::ParsedEvent::CommandBatch(outputs) => {
                            for output in outputs {
                                if matches!(
                                    &output.content,
                                    Some(proto::command_output::Content::Done(_))
                                ) {
                                    done_sent = true;
                                }
                                if tx.send(Ok(output)).await.is_err() {
                                    tracing::debug!(
                                        session_id = %sid,
                                        "run_claude_subprocess: client disconnected"
                                    );
                                    let _ = child.kill().await;
                                    if let Some(cb) = on_exit {
                                        cb().await;
                                    }
                                    return;
                                }
                            }
                        }
                        crate::parser::ParsedEvent::CommandBatchWithTelemetry(
                            outputs,
                            telemetry,
                        ) => {
                            registry.update_telemetry(&sid, &telemetry).await;
                            for output in outputs {
                                if matches!(
                                    &output.content,
                                    Some(proto::command_output::Content::Done(_))
                                ) {
                                    done_sent = true;
                                }
                                if tx.send(Ok(output)).await.is_err() {
                                    tracing::debug!(
                                        session_id = %sid,
                                        "run_claude_subprocess: client disconnected"
                                    );
                                    let _ = child.kill().await;
                                    if let Some(cb) = on_exit {
                                        cb().await;
                                    }
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            Ok(None) => {
                // EOF -- process closed stdout.
                break;
            }
            Err(e) => {
                tracing::warn!(session_id = %sid, "run_claude_subprocess: error reading stdout: {e}");
                break;
            }
        }
    }

    // Wait for process exit and handle non-zero exit codes.
    match child.wait().await {
        Ok(status) => {
            if !status.success() {
                let code = status.code().unwrap_or(-1);
                let stderr_output = stderr_handle.await.unwrap_or_default();
                let stderr_preview = if stderr_output.len() > 200 {
                    format!("{}...", &stderr_output[..200])
                } else {
                    stderr_output
                };
                let msg = if stderr_preview.is_empty() {
                    format!("claude process exited with code {code}")
                } else {
                    format!("claude exited {code}: {}", stderr_preview.trim())
                };
                tracing::warn!(session_id = %sid, "{}", msg);
                let _ = tx
                    .send(Ok(proto::CommandOutput {
                        session_id: sid.clone(),
                        content: Some(proto::command_output::Content::Error(proto::CommandError {
                            message: msg,
                            exit_code: code,
                        })),
                    }))
                    .await;
            }

            // Synthesize a CommandDone if the parser didn't emit one.
            if !done_sent {
                let _ = tx
                    .send(Ok(proto::CommandOutput {
                        session_id: sid.clone(),
                        content: Some(proto::command_output::Content::Done(proto::CommandDone {
                            duration_ms: 0,
                            tool_calls: 0,
                        })),
                    }))
                    .await;
            }

            tracing::info!(
                session_id = %sid,
                exit_code = status.code().unwrap_or(-1),
                "run_claude_subprocess: claude process finished"
            );
        }
        Err(e) => {
            tracing::error!(
                session_id = %sid,
                "run_claude_subprocess: failed to wait on claude process: {e}"
            );
            let _ = tx
                .send(Ok(proto::CommandOutput {
                    session_id: sid.clone(),
                    content: Some(proto::command_output::Content::Error(proto::CommandError {
                        message: format!("failed to wait on process: {e}"),
                        exit_code: -1,
                    })),
                }))
                .await;
        }
    }

    if let Some(cb) = on_exit {
        cb().await;
    }
}
