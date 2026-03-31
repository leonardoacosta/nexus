## REMOVED Requirements

### Requirement: Orphaned Tmp Files
**Reason**: 6 temporary files in nexus-agent are not declared as modules and contain 1,670 lines of dead code leftover from refactoring or editor swap operations.
**Migration**: No migration needed — files are unreferenced. Git history preserves content.

#### Scenario: All orphaned tmp files deleted
- **WHEN** the 6 tmp files are removed from crates/nexus-agent/src/ and crates/nexus-agent/src/grpc/
- **THEN** cargo build -p nexus-agent succeeds and grep finds zero references to the deleted files
