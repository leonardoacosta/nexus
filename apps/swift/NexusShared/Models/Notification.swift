// Notification — payload for the agent's `NotificationFired` SSE event.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.2)
//
// Source of truth: apps/agent/src/notifications/types.ts.
// Cross-platform shape — used by macOS, iOS, watchOS clients.

import Foundation

public struct NotificationEvent: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var id: UUID
    public var body: String
    public var channel: String?
    public var title: String?
    public var emoji: String?
    public var receivedAt: Date

    public init(
        id: UUID = UUID(),
        body: String,
        channel: String? = nil,
        title: String? = nil,
        emoji: String? = nil,
        receivedAt: Date = Date()
    ) {
        self.id = id
        self.body = body
        self.channel = channel
        self.title = title
        self.emoji = emoji
        self.receivedAt = receivedAt
    }
}
