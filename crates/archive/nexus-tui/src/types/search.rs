// ---------------------------------------------------------------------------
// Search state for stream view
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SearchState {
    pub query: String,
    pub match_positions: Vec<usize>, // display line indices with matches
    pub current_match: usize,
}
