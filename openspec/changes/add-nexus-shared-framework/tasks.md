# Tasks: add-nexus-shared-framework

- [x] 1.1 Create apps/swift/NexusShared/ source layout (Models/, Networking/, Observers/ added alongside existing Storage/, Synthesis/ from wave 1)
- [x] 1.2 Implement Codable Models matching TS schema types (Session, Notification, HealthSnapshot, AggregateState)
- [x] 1.3 Implement NexusClient: URLSession SSE subscriber + HTTP fetchers (NexusClient actor + SSEDecoder)
- [x] 1.4 Implement ObservableObject observers for SwiftUI binding (SessionObserver)
- [x] 1.5 Implement SettingsStore + Keychain wrapper (Keychain.swift kept from wave 1; SettingsStore added)
- [x] 1.6 Migrate existing macOS app to consume NexusShared (nx-4roof). Models.swift typealiases `NexusSession=NexusShared.Session`, `NotificationEvent=NexusShared.NotificationEvent`, `HealthPoint=NexusShared.HealthSnapshot` (commit d42cc77 + this sweep). Network.swift retired local `SSEEvent`/`SSE.consume`/`JSONValue`; callers route through `NexusShared.SSEDecoder.consume(url:session:Network.streamingSession,…)` and `NexusShared.SSEEvent` decode-extension methods. `NexusClient` actor + `NexusViewModel` + `NotificationStore` + `AggregateState` + `NexusEndpoint` stay menu-bar-local (composed-not-replaced) — they own Mac-specific concerns (UserDefaults persistence, TTS toggle, `NexusAlert`, `ProcessProbe` fallback, `homelab` accessibility wording, static `baseURL`). 5 files touched (Models.swift, Network.swift, NexusClient.swift, SSEEventParsingTests.swift, this tasks.md). xcodebuild verification tracked in nx-455hi.
- [x] 1.7 Unit tests on each platform target (NexusSharedTests target with AggregateStateTests, SessionDecodingTests, SettingsStoreTests)
