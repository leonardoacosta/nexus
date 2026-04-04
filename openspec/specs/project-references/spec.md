# project-references Specification

## Purpose
TBD - created by archiving change fix-tsconfig-project-refs. Update Purpose after archive.
## Requirements
### Requirement: All package tsconfigs extend tsconfig.base.json

Each of the six package `tsconfig.json` files MUST use `"extends": "../../tsconfig.base.json"`. No other extends change is permitted.

#### Scenario: extends path is correct
- **Given** `packages/core/tsconfig.json` is updated
- **When** `cat packages/core/tsconfig.json | jq '.extends'`
- **Then** the output is `"../../tsconfig.base.json"`

