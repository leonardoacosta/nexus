//! GET /events handler for audit events.

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    /// Filter by event type.
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    /// Filter by target.
    pub target: Option<String>,
    /// Maximum number of events to return (default 100).
    pub limit: Option<u32>,
}

/// GET /events — return recent audit events with optional filters.
pub async fn events_handler(
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
) -> Json<Vec<nexus_core::db::EventRecord>> {
    let limit = query.limit.unwrap_or(100);
    let result = state
        .db
        .query_events(query.event_type.as_deref(), query.target.as_deref(), limit);
    Json(result.unwrap_or_default())
}
