## REMOVED Requirements

### Requirement: Mac-side launchd daemons

**Reason for removal**: With Swift app owning all Mac-side responsibilities (P4) and the bash listener stack retired (P4.7), no Mac daemon infrastructure is needed. The launchd plists (`com.nexus.agent.plist`, `com.nexus.notifier.plist`, `com.nexus.tts-player.plist`) and supporting bash scripts (`nexus-notifier.sh`, `nexus-notifier-status.sh`) become dead deploy artifacts.

**Migration**: 
1. Unload each launchd entry via `launchctl unload ~/Library/LaunchAgents/com.nexus.*.plist`
2. Remove the installed plists from `~/Library/LaunchAgents/`
3. `git rm` the source plists + bash scripts from `deploy/`

#### Scenario: Mac reboots without any Nexus daemons
- **GIVEN** all artifacts are removed + launchd entries unloaded
- **WHEN** the Mac reboots
- **THEN** zero Nexus processes appear in Activity Monitor; only the Swift menu bar app launches (via login items, if configured)

### Requirement: decommissioned Bun listener (nexus-listener.ts)

**Reason for removal**: Decommissioned 2026-05-16 per project memory (double-audio bug when both bash + Bun listeners subscribed to the same SSE stream). The file remains in `deploy/` as stale code.

**Migration**: `git rm deploy/nexus-listener.ts`.

### Requirement: early Swift exploration stub (nexus-stub.swift)

**Reason for removal**: Subsumed by `apps/swift/nexus/`. Pre-Xcode-project exploration code, no longer referenced.

**Migration**: `git rm deploy/nexus-stub.swift`.
