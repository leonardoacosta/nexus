//! GET /failures handler.

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;

use crate::failures::HttpFailuresResponse;

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct FailuresParams {
    #[serde(default = "default_failures_days")]
    pub days: u32,
}

fn default_failures_days() -> u32 {
    7
}

/// GET /failures — return aggregated tool failure data.
pub async fn failures_handler(
    State(state): State<AppState>,
    Query(params): Query<FailuresParams>,
) -> Json<HttpFailuresResponse> {
    Json(state.failure_buffer.query_http(params.days).await)
}
