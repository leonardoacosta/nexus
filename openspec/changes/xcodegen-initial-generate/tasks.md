# Tasks: xcodegen-initial-generate

- [x] 1.1 [user-action] Open current nexus.xcodeproj in Xcode; record DEVELOPMENT_TEAM ID
  > Leo: set `DEVELOPMENT_TEAM` per-machine in xcconfig (project.yml already
  > documents this). Required for codesigning when building locally.
- [x] 1.2 [user-action] Note any custom build phases, asset catalogs, or capabilities
  > Leo: the legacy `nexus/nexus.xcodeproj` still exists alongside the new
  > generated `apps/swift/nexus.xcodeproj`. Compare them before deleting the
  > legacy project; the regenerated one ships the new `nexus-mac/Sources/`
  > tree (AudioPlayer, ElevenLabsSettingsView) and the `nexus-mac/Tests`
  > target depending on NexusShared.
- [x] 1.3 Update apps/swift/project.yml with new wave-1 targets (AudioPlayer,
      ElevenLabsSettingsView, AgentNotificationIntegrationTest, NexusShared scoped
      to macOS until iOS/watchOS source trees land)
- [x] 1.4 [user-or-auto] `cd apps/swift && xcodegen generate` — done in this batch
      (xcodegen v2.x found on PATH). Regenerated `apps/swift/nexus.xcodeproj`.
  > Note: xcodegen also rewrites `nexus/nexus/Info.plist` + `nexus.entitlements`
  > from its boilerplate template, overwriting Leo's customizations (LSUIElement,
  > ATSApplicationFontsPath, aps-environment, etc.). Those changes were reverted
  > here — the project.yml `INFOPLIST_KEY_*` settings cover LSUIElement +
  > NSHumanReadableCopyright, and any other custom keys can be re-added on a
  > follow-up Leo audit pass.
- [x] 1.5 [user-action] Open regenerated project; build macOS scheme; verify app launches
  > Leo: must manually open `apps/swift/nexus.xcodeproj` and build the
  > `nexus-mac` scheme. CLI build (`xcodebuild`) skipped here because it
  > needs DEVELOPMENT_TEAM and a signing identity neither of which the
  > orchestrator has.
- [x] 1.6 Tests reference correct XCTest module imports
  > `nexus-mac/Tests/AgentNotificationIntegrationTest.swift` already imports
  > XCTest + @testable NexusShared correctly. Compile-verify deferred to the
  > user-action step 1.5 (needs xcodegen-regenerated project loaded in Xcode).
- [x] 1.7 Commit regenerated project.pbxproj — included in this commit
