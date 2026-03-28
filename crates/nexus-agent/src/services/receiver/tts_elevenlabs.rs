//! ElevenLabs TTS API integration
//!
//! Provides a client for generating speech audio via the ElevenLabs API.
//! Handles API endpoint construction, voice settings, HTTP requests, and error handling.

use crate::config::NotificationsConfig;
use anyhow::Result;
use serde::Serialize;

/// ElevenLabs API base URL
const ELEVENLABS_API_URL: &str = "https://api.elevenlabs.io/v1/text-to-speech";

/// ElevenLabs TTS request body
#[derive(Debug, Clone, Serialize)]
struct ElevenLabsRequest {
    text: String,
    model_id: String,
    voice_settings: VoiceSettings,
    speed: f32,
}

/// ElevenLabs voice settings
#[derive(Debug, Clone, Serialize)]
struct VoiceSettings {
    stability: f32,
    similarity_boost: f32,
}

/// Configuration for ElevenLabs TTS client
#[derive(Debug, Clone)]
pub struct ElevenLabsConfig {
    /// ElevenLabs API key
    pub api_key: String,
    /// Voice ID to use for TTS
    pub voice_id: String,
    /// Model ID to use for TTS generation
    pub model_id: String,
    /// Voice settings for stability and similarity
    pub voice_settings: ElevenLabsVoiceSettings,
}

/// Voice settings for ElevenLabs TTS
#[derive(Debug, Clone)]
pub struct ElevenLabsVoiceSettings {
    pub stability: f32,
    pub similarity_boost: f32,
    pub speed: f32,
}

/// ElevenLabs TTS client
pub struct ElevenLabsClient {
    api_key: String,
    voice_id: String,
    model_id: String,
    voice_settings: ElevenLabsVoiceSettings,
}

impl ElevenLabsClient {
    /// Create a new ElevenLabs client with the given configuration
    pub fn new(config: &ElevenLabsConfig) -> Self {
        Self {
            api_key: config.api_key.clone(),
            voice_id: config.voice_id.clone(),
            model_id: config.model_id.clone(),
            voice_settings: config.voice_settings.clone(),
        }
    }

    /// Create a client from NotificationsConfig and API key
    pub fn from_notifications_config(config: &NotificationsConfig, api_key: String) -> Self {
        Self {
            api_key,
            voice_id: config.elevenlabs.voice_id.clone(),
            model_id: config.elevenlabs.model_id.clone(),
            voice_settings: ElevenLabsVoiceSettings {
                stability: config.voice_settings.stability,
                similarity_boost: config.voice_settings.similarity_boost,
                speed: config.voice_settings.speed,
            },
        }
    }

    /// Synthesize text to speech audio
    ///
    /// Sends a request to the ElevenLabs API to generate audio from the provided text.
    /// Returns the audio data as MP3-encoded bytes.
    ///
    /// # Errors
    /// Returns error if:
    /// - HTTP request fails
    /// - API returns non-success status
    /// - Response body cannot be read
    pub async fn synthesize(&self, text: &str) -> Result<Vec<u8>, String> {
        let url = format!("{}/{}", ELEVENLABS_API_URL, self.voice_id);

        let request_body = ElevenLabsRequest {
            text: text.to_string(),
            model_id: self.model_id.clone(),
            voice_settings: VoiceSettings {
                stability: self.voice_settings.stability,
                similarity_boost: self.voice_settings.similarity_boost,
            },
            speed: self.voice_settings.speed,
        };

        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .header("xi-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("ElevenLabs API error ({}): {}", status, error_text));
        }

        let audio_data = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read audio data: {}", e))?;

        Ok(audio_data.to_vec())
    }

    /// Synthesize multiple text chunks sequentially and return audio bytes for each.
    ///
    /// Used for extended messages: synthesize chunk N, yield its audio, then chunk N+1.
    /// Returns a Vec of audio byte vectors (one per chunk, in order).
    /// Stops on first synthesis failure and returns chunks synthesized so far.
    pub async fn synthesize_chunks(
        &self,
        chunks: &[String],
        voice_id: Option<&str>,
    ) -> Vec<Result<Vec<u8>, String>> {
        let mut results = Vec::with_capacity(chunks.len());
        for (i, chunk) in chunks.iter().enumerate() {
            tracing::info!(
                "Synthesizing chunk {}/{} ({} chars)",
                i + 1,
                chunks.len(),
                chunk.len()
            );
            let result = if let Some(vid) = voice_id {
                self.synthesize_with_voice(chunk, vid).await
            } else {
                self.synthesize(chunk).await
            };
            let is_err = result.is_err();
            results.push(result);
            if is_err {
                tracing::warn!(
                    "Chunk {}/{} synthesis failed, stopping",
                    i + 1,
                    chunks.len()
                );
                break;
            }
        }
        results
    }

    /// Synthesize text with a custom voice ID
    ///
    /// Allows overriding the default voice ID for a single request.
    pub async fn synthesize_with_voice(
        &self,
        text: &str,
        voice_id: &str,
    ) -> Result<Vec<u8>, String> {
        let url = format!("{}/{}", ELEVENLABS_API_URL, voice_id);

        let request_body = ElevenLabsRequest {
            text: text.to_string(),
            model_id: self.model_id.clone(),
            voice_settings: VoiceSettings {
                stability: self.voice_settings.stability,
                similarity_boost: self.voice_settings.similarity_boost,
            },
            speed: self.voice_settings.speed,
        };

        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .header("xi-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("ElevenLabs API error ({}): {}", status, error_text));
        }

        let audio_data = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read audio data: {}", e))?;

        Ok(audio_data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_elevenlabs_request_serialize() {
        let req = ElevenLabsRequest {
            text: "Hello".to_string(),
            model_id: "eleven_turbo_v2_5".to_string(),
            voice_settings: VoiceSettings {
                stability: 0.5,
                similarity_boost: 0.75,
            },
            speed: 1.2,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"text\":\"Hello\""));
        assert!(json.contains("\"model_id\":\"eleven_turbo_v2_5\""));
        assert!(json.contains("\"stability\":0.5"));
        assert!(json.contains("\"similarity_boost\":0.75"));
        assert!(json.contains("\"speed\":1.2"));
    }

    #[test]
    fn test_client_creation() {
        let config = ElevenLabsConfig {
            api_key: "test_key".to_string(),
            voice_id: "test_voice".to_string(),
            model_id: "eleven_turbo_v2_5".to_string(),
            voice_settings: ElevenLabsVoiceSettings {
                stability: 0.5,
                similarity_boost: 0.75,
                speed: 1.0,
            },
        };

        let client = ElevenLabsClient::new(&config);
        assert_eq!(client.api_key, "test_key");
        assert_eq!(client.voice_id, "test_voice");
        assert_eq!(client.model_id, "eleven_turbo_v2_5");
        assert_eq!(client.voice_settings.stability, 0.5);
        assert_eq!(client.voice_settings.similarity_boost, 0.75);
    }
}
