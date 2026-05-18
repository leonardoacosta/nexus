// NotificationActionRegistry — declares the UNNotificationCategory the
// agent attaches to permission-request notifications.
//
// Spec: openspec/changes/scaffold-nexus-watch-target (task 1.4)
//
// The agent sets `categoryIdentifier = "nexus.permission"` on outbound
// pushes that want Approve / Deny / Custom buttons; iOS + watchOS both
// register this category so the action buttons appear.

import Foundation
import UserNotifications

enum NotificationActionRegistry {
    static let permissionCategoryId = "nexus.permission"
    static let approveActionId = "nexus.permission.approve"
    static let denyActionId = "nexus.permission.deny"
    static let customActionId = "nexus.permission.custom"

    static func registerCategories() {
        let approve = UNNotificationAction(
            identifier: approveActionId,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: denyActionId,
            title: "Deny",
            options: [.destructive]
        )
        let custom = UNNotificationAction(
            identifier: customActionId,
            title: "Continue",
            options: []
        )
        let category = UNNotificationCategory(
            identifier: permissionCategoryId,
            actions: [approve, deny, custom],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }
}
