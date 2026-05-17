## MODIFIED Requirements

### Requirement: nexus.xcodeproj SHALL be generated from apps/swift/project.yml

The Xcode project file at `apps/swift/nexus.xcodeproj/project.pbxproj` SHALL be regenerated from `apps/swift/project.yml` via `xcodegen generate`. After regeneration, hand-editing the .pbxproj is forbidden — all changes flow through the YAML manifest. Development team, code signing, capabilities, and entitlements SHALL be preserved through regeneration.

#### Scenario: regenerated project builds the existing macOS app
- **GIVEN** `xcodegen generate` has run
- **WHEN** `xcodebuild -scheme nexus-mac -workspace apps/swift/nexus.xcworkspace`
- **THEN** build succeeds; the resulting .app launches and shows the menu bar icon as before

#### Scenario: existing tests still pass
- **GIVEN** the regenerated project
- **WHEN** the macOS test schemes are run
- **THEN** `nexusTests` and `nexusUITests` are both green
