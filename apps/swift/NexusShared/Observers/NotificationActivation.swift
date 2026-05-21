// NotificationActivation — extracts the optional `logPath` payload the
// Mac notification renderer stashes on every nx banner, so a clicked
// notification can be routed to the OS default file opener.
//
// Spec: openspec/changes/adopt-reaper-into-nx-cron (task 3.3 — fixes the
// raw-osascript click-attribution bug by attributing the open() to the
// signed nexus.app process via `NSWorkspace.shared.open(_:)`).
//
// Why this lives in NexusShared
// ─────────────────────────────
// The bridge is pure string + URL plumbing — no AppKit, no AVFoundation.
// Keeping it cross-platform lets iOS / watchOS reuse the same userInfo
// contract if they grow click-routed log opens later. The macOS-only
// `NSWorkspace` call lives in the nexus-mac AppKit-bound delegate.

import Foundation

/// Plain-Swift result of inspecting a notification's userInfo dictionary
/// for the canonical `nexus.logPath` value. Distinct from the macOS
/// `UNNotificationResponse` machinery so it's straightforward to unit-test
/// on a free-standing test bundle without spinning a real notification
/// center (Apple's `UNNotificationResponse` initializers are SPI-only).
public enum NotificationActivationTarget: Equatable, Sendable {
    /// No `nexus.logPath` value found, or the value was empty/whitespace.
    /// Callers MUST fall through to the default activation (focus the
    /// app, open the dashboard, etc.) — this case explicitly preserves
    /// pre-fix behavior for non-reaper notifications.
    case defaultActivation
    /// A non-empty `logPath` was found. Callers SHOULD route this URL to
    /// the OS default opener (`NSWorkspace.shared.open(_:)` on macOS) to
    /// route click attribution to the signed app bundle.
    case openFile(URL)
}

/// Stateless extractor used by the macOS AppKit delegate to decide
/// whether to open a log file on banner-click activation. Centralised so
/// the user-info key spelling, whitespace-trim policy, and URL
/// construction live in one place (mirrored by `NotificationUserInfoKeys`
/// on the write side).
public enum NotificationActivation {
    /// Resolve a userInfo dictionary into an activation target. Accepts
    /// `[AnyHashable: Any]` (the wire shape Apple hands the delegate) so
    /// callers don't have to pre-narrow the type. A non-string value or a
    /// blank string yields `.defaultActivation`.
    public static func target(
        from userInfo: [AnyHashable: Any]
    ) -> NotificationActivationTarget {
        guard let raw = userInfo[NotificationUserInfoKeys.logPath] as? String else {
            return .defaultActivation
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return .defaultActivation
        }
        // `URL(fileURLWithPath:)` always succeeds for non-empty strings —
        // it does NOT validate filesystem existence. That's intentional:
        // the OS opener owns "does the file exist" semantics, and a
        // freshly-rotated log path may briefly fail to exist on the
        // millisecond the user clicks. Surfacing the URL lets the opener
        // produce the canonical "no application set to open this file"
        // dialog instead of the renderer silently swallowing the click.
        return .openFile(URL(fileURLWithPath: trimmed))
    }
}
