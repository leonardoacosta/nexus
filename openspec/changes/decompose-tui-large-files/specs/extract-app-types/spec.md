# Spec: extract-app-types

## MODIFIED Requirements

### Requirement: Type modules extracted from app.rs
The 23 public types and enums currently defined in `crates/nexus-tui/src/app.rs` MUST be moved into domain-grouped submodules under `crates/nexus-tui/src/types/`. The `App` struct and its impl blocks remain in app.rs. All types MUST be re-exported from `types/mod.rs` to preserve existing import compatibility.

#### Scenario: Types are accessible after extraction
- **GIVEN** the types module exists at `crates/nexus-tui/src/types/mod.rs`
- **WHEN** any file in nexus-tui imports a type (e.g., `use crate::types::Screen`)
- **THEN** the import resolves correctly and `cargo check -p nexus-tui` passes with zero errors

#### Scenario: app.rs contains only App struct
- **GIVEN** type extraction is complete
- **WHEN** inspecting `crates/nexus-tui/src/app.rs`
- **THEN** the file contains only the `App` struct definition, its impl blocks, and necessary imports — no standalone type/enum definitions except App itself
