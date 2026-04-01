//! GET /cron handler.

use axum::Json;
use axum::extract::State;

use crate::cron_state::CronResponse;

use super::AppState;

/// GET /cron — return cron job run history.
pub async fn cron_handler(State(state): State<AppState>) -> Json<CronResponse> {
    let snapshot = state.cron_state.snapshot().await;
    Json(CronResponse {
        jobs: snapshot.into_iter().map(|(k, v)| (k, v.into())).collect(),
    })
}
