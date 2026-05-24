// WindowAccessor — bridge SwiftUI views to their underlying NSWindow.
//
// SwiftUI's `Window(...)` scene does not expose the underlying NSWindow
// directly, so AppKit-level configuration (collection behavior, title-bar
// styling, etc.) requires a thin NSViewRepresentable that resolves the
// hosting window on appear and passes it to a caller-supplied closure.
//
// Spec: bd:nx-chztj (nx-2pmzs follow-up) — enables green-button →
// fullscreen on the dashboard `Window` scene by inserting
// `.fullScreenPrimary` into `NSWindow.collectionBehavior`.
//       openspec/changes/pty-adaptive-geometry-fullscreen (task 2.7,
//       bd:nx-ggepd) — make the application reliable so the green button
//       always enters a fullscreen Space.
//
// Usage:
//   AppNavigation()
//     .background(WindowAccessor { window in
//       window.collectionBehavior.insert(.fullScreenPrimary)
//     })
//
// The view itself is zero-size and invisible; only side effects on the
// resolved NSWindow matter.
//
// Why retries + re-apply (task 2.7): a SwiftUI `Window` scene LAZY-mounts,
// so on the first runloop tick after `makeNSView` `view.window` is frequently
// nil. The old one-shot `DispatchQueue.main.async { if let window … }`
// silently no-op'd in that race, so `.fullScreenPrimary` was never set and the
// green button only zoomed/maximized instead of entering a fullscreen Space.
// We now (a) poll the next few runloop ticks until `view.window` resolves, and
// (b) re-apply from `updateNSView`. `collectionBehavior.insert(...)` and
// `NSApp.activate` are idempotent, so repeated application is harmless.

import AppKit
import SwiftUI

struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    /// Bounded retry budget — the Window scene mounts within a handful of
    /// runloop ticks; 60 ticks (~1s at typical cadence) is generous headroom
    /// without spinning forever if the view is detached.
    private static let maxResolutionAttempts = 60

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        Self.resolveWindow(for: view, attempt: 0, onWindow: onWindow)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Re-apply on every SwiftUI update — covers the case where the window
        // attaches AFTER makeNSView's retry budget elapsed, and re-asserts the
        // collection behavior if AppKit reset it. insert(...) is idempotent.
        if let window = nsView.window {
            onWindow(window)
        } else {
            Self.resolveWindow(for: nsView, attempt: 0, onWindow: onWindow)
        }
    }

    /// Hop to the next runloop tick until `view.window` is non-nil, then apply
    /// `onWindow`. Bounded by `maxResolutionAttempts` so a never-attached view
    /// (e.g. torn down before mount) doesn't loop forever.
    private static func resolveWindow(
        for view: NSView,
        attempt: Int,
        onWindow: @escaping (NSWindow) -> Void
    ) {
        if let window = view.window {
            onWindow(window)
            return
        }
        guard attempt < maxResolutionAttempts else { return }
        DispatchQueue.main.async {
            resolveWindow(for: view, attempt: attempt + 1, onWindow: onWindow)
        }
    }
}
