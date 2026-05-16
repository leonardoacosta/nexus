//
//  NotificationStore.swift
//  nexus
//
//  Persists the in-app notification ring buffer to `UserDefaults` under the
//  suite name `com.nexus.menubar`, key `nx.menubar.notifications.history`,
//  per spec § "NOTIFY action shows notification history" and tasks 1.16 + 2.5.
//

import Foundation

/// Thread-safe wrapper around the menu bar's `UserDefaults` suite. Marked
/// `nonisolated` because both the actor and MainActor view models call into
/// it; `UserDefaults` itself is documented thread-safe.
nonisolated final class NotificationStore: @unchecked Sendable {
    static let shared = NotificationStore()

    static let suiteName = "com.nexus.menubar"
    static let key = "nx.menubar.notifications.history"

    private let defaults: UserDefaults

    init(suiteName: String = NotificationStore.suiteName) {
        // `UserDefaults(suiteName:)` returns nil only on collision with the
        // global domain; fallback keeps the store usable in tests.
        self.defaults = UserDefaults(suiteName: suiteName) ?? .standard
    }

    func load() -> [NotificationEvent] {
        guard let data = defaults.data(forKey: Self.key) else { return [] }
        return (try? JSONDecoder().decode([NotificationEvent].self, from: data)) ?? []
    }

    func save(_ events: [NotificationEvent]) {
        let data = (try? JSONEncoder().encode(events)) ?? Data()
        defaults.set(data, forKey: Self.key)
    }

    /// Test-only: wipe the persisted buffer.
    func reset() { defaults.removeObject(forKey: Self.key) }
}
