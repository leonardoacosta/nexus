//! Message buffering and debouncing for TTS notifications
//!
//! Implements a sliding window debounce pattern to combine rapid notifications:
//! - Messages are grouped by project key (or "global" if no project)
//! - Each project has its own debounce window (default 4 seconds)
//! - After the window expires with no new messages, buffered messages are combined
//! - Force flush when buffer exceeds max_buffer limit
//!
//! Smart message combination strategies:
//! - 1 message: passthrough
//! - 2-3 messages: concatenate with "and"
//! - 4+ messages: summarize with count (detects completion/error patterns)

use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::debug;

/// A single buffered message entry
#[derive(Debug, Clone)]
pub struct BufferEntry {
    /// The message text
    pub message: String,
    /// Optional project identifier
    pub project: Option<String>,
    /// Optional voice override
    pub voice: Option<String>,
    /// When the message was received
    pub received_at: Instant,
}

/// Per-project buffer state
#[derive(Debug, Default)]
struct ProjectBuffer {
    /// Buffered messages for this project
    messages: Vec<BufferEntry>,
    /// Whether a flush is currently in progress
    flush_in_progress: bool,
}

/// Message buffer that groups messages by project and implements sliding window debounce
///
/// When a message arrives:
/// 1. Add to buffer (grouped by project key)
/// 2. Reset the debounce timer for that project
/// 3. After debounce_window duration of no new messages, flush and combine
/// 4. Force flush if buffer exceeds max_size
pub struct MessageBuffer {
    /// Per-project buffers (key: project name or "global")
    buffers: HashMap<String, ProjectBuffer>,
    /// Debounce window duration
    debounce_window: Duration,
    /// Maximum buffer size before force flush
    max_size: usize,
}

impl MessageBuffer {
    /// Create a new message buffer with specified settings
    pub fn new(debounce_window: Duration, max_size: usize) -> Self {
        Self {
            buffers: HashMap::new(),
            debounce_window,
            max_size,
        }
    }

    /// Get the buffer key for a project (defaults to "global" if None)
    fn get_project_key(project: &Option<String>) -> String {
        project.clone().unwrap_or_else(|| "global".to_string())
    }

    /// Add a message to the buffer
    ///
    /// Returns Some((combined_message, project, voice)) if buffer should be flushed immediately (force flush).
    /// Returns None if the message was buffered and will be flushed later by the debounce timer.
    pub fn add_message(
        &mut self,
        entry: BufferEntry,
    ) -> Option<(String, Option<String>, Option<String>)> {
        let key = Self::get_project_key(&entry.project);
        let project = entry.project.clone();
        let voice = entry.voice.clone();

        let buffer = self.buffers.entry(key.clone()).or_default();

        // Don't add if flush is in progress
        if buffer.flush_in_progress {
            return None;
        }

        buffer.messages.push(entry);

        // Force flush if buffer is full
        if buffer.messages.len() >= self.max_size {
            debug!("Buffer full for project {:?}, force flushing", key);
            return self.flush_buffer(&key, project, voice);
        }

        None
    }

    /// Check if a buffer is ready to flush (debounce window expired since last message)
    pub fn should_flush(&self, project_key: &str) -> bool {
        if let Some(buffer) = self.buffers.get(project_key) {
            if buffer.messages.is_empty() || buffer.flush_in_progress {
                return false;
            }
            if let Some(last) = buffer.messages.last() {
                return last.received_at.elapsed() >= self.debounce_window;
            }
        }
        false
    }

    /// Get all project keys that have pending messages
    pub fn pending_project_keys(&self) -> Vec<String> {
        self.buffers
            .iter()
            .filter(|(_, buf)| !buf.messages.is_empty() && !buf.flush_in_progress)
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// Flush the buffer for a specific project and return combined message
    ///
    /// Returns Some((combined_message, project, voice)) if there were buffered messages.
    /// Returns None if the buffer was empty or a flush is already in progress.
    pub fn flush_buffer(
        &mut self,
        project_key: &str,
        project: Option<String>,
        voice: Option<String>,
    ) -> Option<(String, Option<String>, Option<String>)> {
        let buffer = self.buffers.get_mut(project_key)?;

        if buffer.messages.is_empty() || buffer.flush_in_progress {
            return None;
        }

        buffer.flush_in_progress = true;

        let messages: Vec<String> = buffer.messages.iter().map(|e| e.message.clone()).collect();
        let combined = Self::smart_combine(&messages);

        // Clear the buffer
        buffer.messages.clear();
        buffer.flush_in_progress = false;

        Some((combined, project, voice))
    }

    /// Smart message combination - uses different strategies based on count
    ///
    /// - 1 message: passthrough
    /// - 2-3 messages: concatenate with "and"
    /// - 4+ messages: summarize with count (detects completion/error patterns)
    pub fn smart_combine(messages: &[String]) -> String {
        if messages.is_empty() {
            return String::new();
        }

        if messages.len() == 1 {
            return messages[0].clone();
        }

        // Detect completion patterns
        let has_completion = messages.iter().any(|m| {
            let lower = m.to_lowercase();
            lower.contains("complete") || lower.contains("done") || lower.contains("finished")
        });

        // Detect error patterns
        let has_error = messages.iter().any(|m| {
            let lower = m.to_lowercase();
            lower.contains("error") || lower.contains("failed") || lower.contains("warning")
        });

        if messages.len() <= 3 {
            // Concatenate 2-3 messages
            messages.join(", and ")
        } else {
            // 4+ messages: summarize
            if has_error {
                format!(
                    "{} updates with errors: {}",
                    messages.len(),
                    messages.last().unwrap()
                )
            } else if has_completion {
                format!("{} tasks completed", messages.len())
            } else {
                format!("{} updates: {}", messages.len(), messages.last().unwrap())
            }
        }
    }

    /// Get project and voice info from the first message in a buffer
    ///
    /// Returns (project, voice) if the buffer exists and has messages.
    /// Returns (None, None) if the buffer is empty or doesn't exist.
    pub fn get_buffer_info(&self, project_key: &str) -> (Option<String>, Option<String>) {
        self.buffers
            .get(project_key)
            .and_then(|b| b.messages.first())
            .map(|e| (e.project.clone(), e.voice.clone()))
            .unwrap_or((None, None))
    }

    /// Get the total count of buffered messages across all projects
    pub fn total_count(&self) -> usize {
        self.buffers.values().map(|b| b.messages.len()).sum()
    }

    /// Access internal buffers for testing purposes
    #[cfg(test)]
    pub(crate) fn buffers(&self) -> &HashMap<String, ProjectBuffer> {
        &self.buffers
    }
}

// Make ProjectBuffer public for tests
#[cfg(test)]
impl ProjectBuffer {
    pub fn messages(&self) -> &[BufferEntry] {
        &self.messages
    }

    pub fn flush_in_progress(&self) -> bool {
        self.flush_in_progress
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_buffer_single_message() {
        let mut buffer = MessageBuffer::new(Duration::from_millis(4000), 5);

        let entry = BufferEntry {
            message: "Hello world".to_string(),
            project: Some("test-project".to_string()),
            voice: None,
            received_at: Instant::now(),
        };

        // Single message should be buffered, not force-flushed
        let result = buffer.add_message(entry);
        assert!(result.is_none());
        assert_eq!(buffer.total_count(), 1);
    }

    #[test]
    fn test_message_buffer_force_flush_at_max() {
        let max_buffer_size = 5;
        let mut buffer = MessageBuffer::new(Duration::from_millis(4000), max_buffer_size);

        // Add max_buffer_size messages - the last one should trigger force flush
        for i in 0..max_buffer_size {
            let entry = BufferEntry {
                message: format!("Message {}", i),
                project: Some("test".to_string()),
                voice: None,
                received_at: Instant::now(),
            };

            let result = buffer.add_message(entry);

            if i < max_buffer_size - 1 {
                assert!(result.is_none(), "Should not flush before max");
            } else {
                assert!(result.is_some(), "Should flush at max");
                let (combined, project, _) = result.unwrap();
                assert!(combined.contains("updates"));
                assert_eq!(project, Some("test".to_string()));
            }
        }

        // Buffer should be empty after flush
        assert_eq!(buffer.total_count(), 0);
    }

    #[test]
    fn test_message_buffer_smart_combine_single() {
        let messages = vec!["Hello".to_string()];
        let combined = MessageBuffer::smart_combine(&messages);
        assert_eq!(combined, "Hello");
    }

    #[test]
    fn test_message_buffer_smart_combine_two() {
        let messages = vec!["Hello".to_string(), "World".to_string()];
        let combined = MessageBuffer::smart_combine(&messages);
        assert_eq!(combined, "Hello, and World");
    }

    #[test]
    fn test_message_buffer_smart_combine_three() {
        let messages = vec![
            "First".to_string(),
            "Second".to_string(),
            "Third".to_string(),
        ];
        let combined = MessageBuffer::smart_combine(&messages);
        assert_eq!(combined, "First, and Second, and Third");
    }

    #[test]
    fn test_message_buffer_smart_combine_many_with_completion() {
        let messages = vec![
            "Task 1 complete".to_string(),
            "Task 2 done".to_string(),
            "Task 3 finished".to_string(),
            "Task 4 complete".to_string(),
        ];
        let combined = MessageBuffer::smart_combine(&messages);
        assert_eq!(combined, "4 tasks completed");
    }

    #[test]
    fn test_message_buffer_smart_combine_many_with_errors() {
        let messages = vec![
            "Build started".to_string(),
            "Test failed".to_string(),
            "Lint warning".to_string(),
            "Build error".to_string(),
        ];
        let combined = MessageBuffer::smart_combine(&messages);
        assert!(combined.contains("4 updates with errors"));
        assert!(combined.contains("Build error"));
    }

    #[test]
    fn test_message_buffer_smart_combine_many_generic() {
        let messages = vec![
            "Update 1".to_string(),
            "Update 2".to_string(),
            "Update 3".to_string(),
            "Update 4".to_string(),
        ];
        let combined = MessageBuffer::smart_combine(&messages);
        assert_eq!(combined, "4 updates: Update 4");
    }

    #[test]
    fn test_message_buffer_project_key() {
        assert_eq!(
            MessageBuffer::get_project_key(&Some("my-project".to_string())),
            "my-project"
        );
        assert_eq!(MessageBuffer::get_project_key(&None), "global");
    }

    #[test]
    fn test_message_buffer_separate_projects() {
        let mut buffer = MessageBuffer::new(Duration::from_millis(4000), 5);

        // Add messages for different projects
        let entry1 = BufferEntry {
            message: "Project A message".to_string(),
            project: Some("project-a".to_string()),
            voice: None,
            received_at: Instant::now(),
        };
        let entry2 = BufferEntry {
            message: "Project B message".to_string(),
            project: Some("project-b".to_string()),
            voice: None,
            received_at: Instant::now(),
        };

        buffer.add_message(entry1);
        buffer.add_message(entry2);

        // Should have 2 messages total across 2 projects
        assert_eq!(buffer.total_count(), 2);
        assert_eq!(buffer.pending_project_keys().len(), 2);
    }

    #[test]
    fn test_debounce_window_not_expired() {
        let buffer = MessageBuffer::new(Duration::from_millis(4000), 5);
        // No messages in buffer, should not flush
        assert!(!buffer.should_flush("test-project"));
    }

    #[test]
    fn test_pending_project_keys_excludes_empty() {
        let mut buffer = MessageBuffer::new(Duration::from_millis(4000), 5);

        let entry = BufferEntry {
            message: "Test".to_string(),
            project: Some("project-a".to_string()),
            voice: None,
            received_at: Instant::now(),
        };

        buffer.add_message(entry);

        // Should only return projects with pending messages
        let keys = buffer.pending_project_keys();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0], "project-a");
    }

    #[test]
    fn test_flush_buffer_clears_messages() {
        let mut buffer = MessageBuffer::new(Duration::from_millis(4000), 5);

        let entry = BufferEntry {
            message: "Test message".to_string(),
            project: Some("test".to_string()),
            voice: None,
            received_at: Instant::now(),
        };

        buffer.add_message(entry);
        assert_eq!(buffer.total_count(), 1);

        // Flush the buffer
        let result = buffer.flush_buffer("test", Some("test".to_string()), None);
        assert!(result.is_some());

        // Buffer should be empty
        assert_eq!(buffer.total_count(), 0);
    }

    #[test]
    fn test_flush_in_progress_prevents_add() {
        let mut buffer = MessageBuffer::new(Duration::from_millis(4000), 5);

        // Add a message
        let entry1 = BufferEntry {
            message: "First".to_string(),
            project: Some("test".to_string()),
            voice: None,
            received_at: Instant::now(),
        };
        buffer.add_message(entry1);

        // Manually set flush_in_progress
        if let Some(buf) = buffer.buffers.get_mut("test") {
            buf.flush_in_progress = true;
        }

        // Try to add another message while flush is in progress
        let entry2 = BufferEntry {
            message: "Second".to_string(),
            project: Some("test".to_string()),
            voice: None,
            received_at: Instant::now(),
        };
        let result = buffer.add_message(entry2);

        // Should return None and not add the message
        assert!(result.is_none());
        assert_eq!(buffer.total_count(), 1); // Still just the first message
    }

    #[test]
    fn test_empty_messages_smart_combine() {
        let messages: Vec<String> = vec![];
        let combined = MessageBuffer::smart_combine(&messages);
        assert_eq!(combined, "");
    }
}
