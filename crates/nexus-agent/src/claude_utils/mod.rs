//\! Compatibility shim for claude_utils types used by the absorbed
//\! claude-daemon services. Provides notification mode, config, path,
//\! and project utilities without a build.rs dependency.

pub mod log;
pub mod notification_config;
pub mod notification_mode;
pub mod notify;
pub mod path;
pub mod project;
