## MODIFIED Requirements

### Requirement: Standardized home_dir in cron.rs
The raw `std::env::var("HOME")` call at `cron.rs:359` SHALL be replaced with `nexus_core::paths::home_dir()` for consistent fallback behavior.

#### Scenario: Cron uses standardized home_dir
- **GIVEN** the cron module resolves the home directory
- **WHEN** the code path at line 359 executes
- **THEN** it calls `nexus_core::paths::home_dir()` instead of `std::env::var("HOME")`
- **AND** benefits from the `/tmp` fallback when `$HOME` is unset
