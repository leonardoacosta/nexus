# Tasks: add-nexus-shared-framework

- [x] 1.1 Create apps/swift/NexusShared/ source layout (Models/, Networking/, Observers/ added alongside existing Storage/, Synthesis/ from wave 1)
- [x] 1.2 Implement Codable Models matching TS schema types (Session, Notification, HealthSnapshot, AggregateState)
- [x] 1.3 Implement NexusClient: URLSession SSE subscriber + HTTP fetchers (NexusClient actor + SSEDecoder)
- [x] 1.4 Implement ObservableObject observers for SwiftUI binding (SessionObserver)
- [x] 1.5 Implement SettingsStore + Keychain wrapper (Keychain.swift kept from wave 1; SettingsStore added)
- [ ] 1.6 Migrate existing macOS app to consume NexusShared (deferred to nx-4roof — ~10-file rename sweep, requires per-symbol audit of NexusSession/HealthPoint/AggregateState/NexusViewModel/Network/SSE; out of scope for framework-creation spec)
- [x] 1.7 Unit tests on each platform target (NexusSharedTests target with AggregateStateTests, SessionDecodingTests, SettingsStoreTests)
