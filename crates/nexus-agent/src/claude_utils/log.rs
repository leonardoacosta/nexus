/// Timestamped logging helper
/// Logs to stderr to avoid interfering with stdout-based communication
use chrono::Local;

/// Log a message to stderr with timestamp and prefix
///
/// Format: [TIMESTAMP] [PREFIX] MSG
/// Timestamp is system-local, human-readable (e.g. "Mar 01 16:07:45")
///
/// # Examples
///
/// ```ignore
/// use claude_utils::log::log;
///
/// log("INFO", "Application started");
/// log("ERROR", "Failed to connect to database");
/// ```ignore
pub fn log(prefix: &str, msg: &str) {
    let ts = Local::now().format("%b %d %H:%M:%S");
    eprintln!("[{}] [{}] {}", ts, prefix, msg);
}
