//! Message deduplication for TTS receiver
//!
//! Prevents duplicate TTS requests within a configurable time window.
//! Uses message content hashing (first 100 chars) to detect duplicates.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};
use tracing::debug;

/// Message deduplicator to prevent duplicate TTS requests
///
/// Tracks recently seen messages by hash and timestamp.
/// Messages within the deduplication window are considered duplicates.
pub struct Deduplicator {
    /// Map of message hash to timestamp when first seen
    recent_messages: HashMap<u64, Instant>,
    /// Duration after which entries are considered expired
    window: Duration,
}

impl Deduplicator {
    /// Create a new deduplicator with the specified window duration
    pub fn new(window: Duration) -> Self {
        Self {
            recent_messages: HashMap::new(),
            window,
        }
    }

    /// Generate a hash for the message text
    /// Uses first 100 characters for brief messages (similar to the TS implementation).
    /// For extended messages, hashes the full content to avoid collisions on long text.
    #[cfg(test)]
    fn hash_message(message: &str) -> u64 {
        Self::hash_message_with_type(message, false)
    }

    /// Generate a hash for the message text, optionally using the full content.
    /// When `full_content` is true (for extended messages), hashes the entire message.
    /// When false (brief messages), truncates to 100 chars before hashing.
    fn hash_message_with_type(message: &str, full_content: bool) -> u64 {
        let to_hash = if full_content || message.len() <= 100 {
            message
        } else {
            &message[..100]
        };
        let mut hasher = DefaultHasher::new();
        to_hash.hash(&mut hasher);
        hasher.finish()
    }

    /// Remove entries older than the deduplication window
    fn cleanup(&mut self) {
        let now = Instant::now();
        self.recent_messages
            .retain(|_, timestamp| now.duration_since(*timestamp) < self.window);
    }

    /// Check if a message is a duplicate within the deduplication window
    /// If not a duplicate, adds it to the cache and returns false
    /// If a duplicate, returns true
    pub fn is_duplicate(&mut self, message: &str) -> bool {
        self.is_duplicate_ext(message, false)
    }

    /// Check if a message is a duplicate, with extended message support.
    /// For extended messages (`full_content=true`), hashes the full message content
    /// instead of truncating to 100 chars, preventing false dedup matches on long text.
    pub fn is_duplicate_ext(&mut self, message: &str, full_content: bool) -> bool {
        // Clean old entries first
        self.cleanup();

        let hash = Self::hash_message_with_type(message, full_content);

        if self.recent_messages.contains_key(&hash) {
            debug!("Duplicate message detected (hash: {})", hash);
            return true;
        }

        // Add to cache
        self.recent_messages.insert(hash, Instant::now());
        false
    }

    /// Get the current cache size (for health/stats)
    #[allow(dead_code)]
    pub fn cache_size(&mut self) -> usize {
        self.cleanup();
        self.recent_messages.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_message_consistency() {
        // Same message should produce same hash
        let hash1 = Deduplicator::hash_message("Hello world");
        let hash2 = Deduplicator::hash_message("Hello world");
        assert_eq!(hash1, hash2);

        // Different messages should produce different hashes
        let hash3 = Deduplicator::hash_message("Goodbye world");
        assert_ne!(hash1, hash3);
    }

    #[test]
    fn test_hash_truncates_long_messages() {
        // Messages longer than 100 chars should be truncated before hashing
        let long_msg = "a".repeat(200);
        let truncated = "a".repeat(100);

        let hash_long = Deduplicator::hash_message(&long_msg);
        let hash_truncated = Deduplicator::hash_message(&truncated);

        // Hashes should match since both are truncated to 100 chars
        assert_eq!(hash_long, hash_truncated);
    }

    #[test]
    fn test_detects_duplicates() {
        let mut dedup = Deduplicator::new(Duration::from_secs(10));

        // First message should not be duplicate
        assert!(!dedup.is_duplicate("Hello"));

        // Same message should be duplicate
        assert!(dedup.is_duplicate("Hello"));

        // Different message should not be duplicate
        assert!(!dedup.is_duplicate("World"));
    }

    #[test]
    fn test_cache_size() {
        let mut dedup = Deduplicator::new(Duration::from_secs(10));

        dedup.is_duplicate("Message 1");
        dedup.is_duplicate("Message 2");
        dedup.is_duplicate("Message 3");

        assert_eq!(dedup.cache_size(), 3);
    }

    #[test]
    fn test_cleanup_expired_entries() {
        let mut dedup = Deduplicator::new(Duration::from_millis(50));

        // Add messages
        assert!(!dedup.is_duplicate("Message 1"));
        assert!(!dedup.is_duplicate("Message 2"));

        // Wait for window to expire
        std::thread::sleep(Duration::from_millis(100));

        // Cleanup should remove expired entries
        dedup.cleanup();
        assert_eq!(dedup.cache_size(), 0);

        // Messages should not be duplicates anymore
        assert!(!dedup.is_duplicate("Message 1"));
    }

    #[test]
    fn test_duplicate_within_window() {
        let mut dedup = Deduplicator::new(Duration::from_secs(1));

        // First occurrence
        assert!(!dedup.is_duplicate("Test message"));

        // Immediate duplicate
        assert!(dedup.is_duplicate("Test message"));

        // Wait less than window
        std::thread::sleep(Duration::from_millis(500));

        // Still within window, should be duplicate
        assert!(dedup.is_duplicate("Test message"));
    }

    #[test]
    fn test_duplicate_after_window() {
        let mut dedup = Deduplicator::new(Duration::from_millis(100));

        // First occurrence
        assert!(!dedup.is_duplicate("Test message"));

        // Wait for window to expire
        std::thread::sleep(Duration::from_millis(150));

        // Should no longer be duplicate
        assert!(!dedup.is_duplicate("Test message"));
    }

    #[test]
    fn test_multiple_messages_independent() {
        let mut dedup = Deduplicator::new(Duration::from_secs(10));

        // Add three different messages
        assert!(!dedup.is_duplicate("Message A"));
        assert!(!dedup.is_duplicate("Message B"));
        assert!(!dedup.is_duplicate("Message C"));

        // Each should be tracked independently
        assert!(dedup.is_duplicate("Message A"));
        assert!(dedup.is_duplicate("Message B"));
        assert!(dedup.is_duplicate("Message C"));

        assert_eq!(dedup.cache_size(), 3);
    }

    #[test]
    fn test_empty_message() {
        let mut dedup = Deduplicator::new(Duration::from_secs(10));

        // Empty messages should be deduplicated
        assert!(!dedup.is_duplicate(""));
        assert!(dedup.is_duplicate(""));
    }

    #[test]
    fn test_whitespace_variations() {
        let mut dedup = Deduplicator::new(Duration::from_secs(10));

        // Different whitespace = different messages
        assert!(!dedup.is_duplicate("Hello world"));
        assert!(!dedup.is_duplicate("Hello  world"));
        assert!(!dedup.is_duplicate("Hello\nworld"));

        // Same whitespace = duplicate
        assert!(dedup.is_duplicate("Hello world"));
    }

    #[test]
    fn test_case_sensitive() {
        let mut dedup = Deduplicator::new(Duration::from_secs(10));

        // Case differences = different messages
        assert!(!dedup.is_duplicate("Hello"));
        assert!(!dedup.is_duplicate("hello"));
        assert!(!dedup.is_duplicate("HELLO"));

        // Same case = duplicate
        assert!(dedup.is_duplicate("Hello"));
    }
}
