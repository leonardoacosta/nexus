// Screen rendering modules.
// Each screen implements a render function that draws to a ratatui Frame.

pub mod dashboard;    // Screen 1: Session list grouped by project
pub mod detail;       // Screen 2: Single session expanded view
pub mod health;       // Screen 3: System health overview
pub mod projects;     // Screen 4: Project overview table
pub mod palette;      // Screen 5: Command palette overlay
