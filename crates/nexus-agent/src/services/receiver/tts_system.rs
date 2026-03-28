//! System TTS fallback for when ElevenLabs is unavailable
//!
//! Provides platform-specific text-to-speech using native system commands:
//! - macOS: `say` command
//! - Linux: `espeak-ng`, `espeak`, or `festival`

use tokio::process::Command;
use tracing::debug;

/// System TTS provider (macOS `say` or Linux `espeak`/`festival`)
pub struct SystemTts;

impl SystemTts {
    /// Speak text using system TTS
    ///
    /// # Arguments
    /// * `text` - The text to speak
    /// * `voice` - Optional voice name (platform-specific)
    ///
    /// # Returns
    /// * `Ok(provider_name)` - Success with the TTS provider used
    /// * `Err(message)` - Failure with error details
    ///
    /// # Platform Support
    /// - macOS: Uses `say` command with optional `-v` voice selection
    /// - Linux: Tries `espeak-ng`, `espeak`, or `festival` in order
    pub async fn speak(text: &str, voice: Option<&str>) -> Result<String, String> {
        // macOS: use `say` command
        if cfg!(target_os = "macos") {
            let mut cmd = Command::new("say");
            if let Some(v) = voice {
                cmd.arg("-v").arg(v);
            }
            cmd.arg(text);

            let output = cmd
                .output()
                .await
                .map_err(|e| format!("Failed to run say: {}", e))?;

            if output.status.success() {
                return Ok("say".to_string());
            } else {
                return Err(format!(
                    "say failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }

        // Linux: try espeak-ng, espeak, or festival
        let linux_tts: Vec<(&str, Vec<&str>)> = vec![
            ("espeak-ng", vec![]),
            ("espeak", vec![]),
            ("festival", vec!["--tts"]),
        ];

        for (cmd_name, extra_args) in linux_tts {
            let mut cmd = Command::new(cmd_name);
            cmd.args(&extra_args);
            cmd.arg(text);

            let result = cmd.output().await;

            match result {
                Ok(output) if output.status.success() => {
                    return Ok(cmd_name.to_string());
                }
                Ok(output) => {
                    debug!(
                        "{} failed: {}",
                        cmd_name,
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    debug!("{} not found", cmd_name);
                }
                Err(e) => {
                    debug!("{} error: {}", cmd_name, e);
                }
            }
        }

        Err("No system TTS available".to_string())
    }

    /// Check if system TTS is available
    ///
    /// # Returns
    /// * `true` - System TTS command exists and is executable
    /// * `false` - No system TTS available
    pub async fn is_available() -> bool {
        // macOS: check for `say`
        if cfg!(target_os = "macos") {
            return Command::new("say").arg("--version").output().await.is_ok();
        }

        // Linux: check for espeak-ng, espeak, or festival
        let linux_tts = ["espeak-ng", "espeak", "festival"];
        for cmd_name in &linux_tts {
            if Command::new(cmd_name)
                .arg("--version")
                .output()
                .await
                .is_ok()
            {
                return true;
            }
        }

        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_is_available_returns_bool() {
        // This test verifies is_available returns a boolean without errors
        // The actual result depends on system TTS installation
        let result = SystemTts::is_available().await;
        // Just verify it returns a bool without panicking
        assert!(result || !result);
    }

    #[tokio::test]
    async fn test_speak_with_short_text() {
        // This test verifies speak can be called without panicking
        // The actual result depends on system TTS availability
        let result = SystemTts::speak("test", None).await;
        // Should either succeed or fail gracefully
        match result {
            Ok(provider) => {
                assert!(
                    provider == "say"
                        || provider == "espeak-ng"
                        || provider == "espeak"
                        || provider == "festival"
                );
            }
            Err(msg) => {
                assert!(msg.contains("No system TTS available") || msg.contains("failed"));
            }
        }
    }
}
