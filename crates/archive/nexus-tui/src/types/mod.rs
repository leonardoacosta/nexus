//! Domain-grouped type definitions extracted from app.rs.
//!
//! Re-exports all public types so callers can use `crate::types::TypeName`.

pub mod agent;
pub mod confirm;
pub mod palette;
pub mod project;
pub mod screen;
pub mod search;
pub mod spec;
pub mod stream_types;
pub mod tabs;

// Re-export all public types for convenient access.
pub use agent::{
    ActivityStatus, AgentData, AgentHealthHistory, AgentOfflineRow, SessionRow, SyncStatus,
};
pub use confirm::ConfirmKind;
pub use palette::{PaletteAction, PaletteEntry};
pub use project::{ProjectDetail, ProjectSummary};
pub use screen::{InputMode, Screen};
pub use search::SearchState;
pub use spec::{SpecDetailState, SpecListEntry};
#[allow(unused_imports)] // verbosity_rank used by app.rs tests
pub use stream_types::{verbosity_rank, LineStyle, StreamLine, StreamVerbosity, StyledLine};
pub use tabs::SessionTab;
