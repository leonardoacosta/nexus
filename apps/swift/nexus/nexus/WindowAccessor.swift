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
//
// Why PERSISTENT re-assertion (bd:nx-ggepd follow-up): even with the retry +
// updateNSView re-apply, the green button STILL reverted to zoom ("+") instead
// of fullscreen (diagonal arrows). Root cause: SwiftUI's `Window` scene MANAGES
// `NSWindow.collectionBehavior` itself (derived from `windowResizability` +
// frame). After our manual `.fullScreenPrimary` insert, SwiftUI RE-APPLIES its
// own collectionBehavior on later AppKit window events (resize, becomeKey,
// becomeMain) that do NOT trigger SwiftUI `updateNSView` — stripping our bit and
// reverting the button to zoom. A one-shot insert (even an updateNSView re-apply)
// loses this race because SwiftUI resets on AppKit-level events SwiftUI's
// representable lifecycle never sees.
//
// Fix: install lightweight `NotificationCenter` observers keyed to the SPECIFIC
// window that re-insert `.fullScreenPrimary` on `didBecomeKeyNotification`,
// `didResizeNotification`, and `didBecomeMainNotification`. These fire on the
// exact AppKit events SwiftUI uses to reset, so our re-assertion runs on the
// same beat and the bit persists. We use NotificationCenter observers rather
// than setting `window.delegate` because SwiftUI installs its OWN delegate to
// drive scene lifecycle (close, restoration, state persistence); replacing it
// breaks SwiftUI's window management. Observers are additive — they coexist
// with SwiftUI's delegate without contention.

import AppKit
import os.log
import SwiftUI

struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    /// Bounded retry budget — the Window scene mounts within a handful of
    /// runloop ticks; 60 ticks (~1s at typical cadence) is generous headroom
    /// without spinning forever if the view is detached.
    private static let maxResolutionAttempts = 60

    /// Diagnostic logger. Subsystem matches the nexus-mac bundle id so the
    /// orchestrator can retrieve lines via `log show --predicate
    /// 'subsystem == "dev.leonardoacosta.nexus.mac"'`.
    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "WindowAccessor"
    )

    /// Coordinator OWNS the NotificationCenter observer tokens so they are
    /// retained for the lifetime of the representable (NotificationCenter holds
    /// only a weak reference to the returned token; if it deallocs the handler
    /// never fires). SwiftUI keeps the Coordinator alive while the view exists.
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let onWindow = self.onWindow
        let coordinator = context.coordinator
        Self.resolveWindow(for: view, attempt: 0) { window in
            Self.apply(to: window, onWindow: onWindow, coordinator: coordinator)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Re-apply on every SwiftUI update — covers the case where the window
        // attaches AFTER makeNSView's retry budget elapsed, and re-asserts the
        // collection behavior if AppKit reset it. insert(...) is idempotent.
        let onWindow = self.onWindow
        let coordinator = context.coordinator
        if let window = nsView.window {
            Self.apply(to: window, onWindow: onWindow, coordinator: coordinator)
        } else {
            Self.resolveWindow(for: nsView, attempt: 0) { window in
                Self.apply(to: window, onWindow: onWindow, coordinator: coordinator)
            }
        }
    }

    /// Run the caller's `onWindow` side effect, then (idempotently) install the
    /// persistent re-assertion observers so SwiftUI's later collectionBehavior
    /// resets can't strip `.fullScreenPrimary`. Static so the async retry chain
    /// captures only the closure + coordinator, never the value-type `self`.
    private static func apply(
        to window: NSWindow,
        onWindow: (NSWindow) -> Void,
        coordinator: Coordinator
    ) {
        onWindow(window)
        coordinator.installFullScreenPersistence(on: window, logger: logger)
    }

    /// Hop to the next runloop tick until `view.window` is non-nil, then apply
    /// `body`. Bounded by `maxResolutionAttempts` so a never-attached view
    /// (e.g. torn down before mount) doesn't loop forever.
    private static func resolveWindow(
        for view: NSView,
        attempt: Int,
        body: @escaping (NSWindow) -> Void
    ) {
        if let window = view.window {
            body(window)
            return
        }
        guard attempt < maxResolutionAttempts else { return }
        DispatchQueue.main.async {
            resolveWindow(for: view, attempt: attempt + 1, body: body)
        }
    }

    // MARK: - Coordinator

    /// Retains the NotificationCenter observer tokens and ensures persistence
    /// is installed exactly once per resolved window.
    final class Coordinator {
        private var observerTokens: [NSObjectProtocol] = []
        /// The window persistence is currently bound to. If SwiftUI ever
        /// re-parents the representable to a different window we tear down and
        /// re-install rather than leaking observers on the stale one.
        private weak var boundWindow: NSWindow?
        /// One-shot guard so the `.error`-level CONFIRMED line is emitted only
        /// once (it abuses .error level purely to persist to the unified log).
        private var loggedConfirmation = false

        deinit {
            removeObservers()
        }

        /// Re-insert `.fullScreenPrimary` and emit a diagnostic line. Idempotent.
        func reassertFullScreen(on window: NSWindow, reason: String, logger: Logger) {
            window.collectionBehavior.insert(.fullScreenPrimary)
            let hasFS = window.collectionBehavior.contains(.fullScreenPrimary)
            logger.info(
                "WindowAccessor: applied fullScreenPrimary (\(reason, privacy: .public)) — behaviorRaw=\(window.collectionBehavior.rawValue, privacy: .public) hasFullScreen=\(hasFS, privacy: .public) styleMaskRaw=\(window.styleMask.rawValue, privacy: .public)"
            )

            // Abuse .error level (intentionally) on the FIRST successful apply so
            // the line persists to the unified log and the orchestrator can read
            // it via `log show` — info/debug are memory-only in Release builds.
            if hasFS && !loggedConfirmation {
                loggedConfirmation = true
                logger.error(
                    "WindowAccessor: fullScreenPrimary CONFIRMED set (diagnostic, not an error) raw=\(window.collectionBehavior.rawValue, privacy: .public)"
                )
            }
        }

        /// Install persistent observers on `window` (once). Subsequent calls for
        /// the SAME window are no-ops; a different window triggers re-install.
        func installFullScreenPersistence(on window: NSWindow, logger: Logger) {
            if boundWindow === window {
                // Already wired — just re-assert (idempotent) in case SwiftUI
                // reset between observer fires.
                reassertFullScreen(on: window, reason: "re-apply", logger: logger)
                return
            }
            removeObservers()
            boundWindow = window

            let center = NotificationCenter.default
            // These three notifications cover the AppKit events SwiftUI uses to
            // re-derive (and thereby strip) collectionBehavior: key focus,
            // resize, and main-window transition. Re-asserting on each keeps the
            // bit alive across SwiftUI's resets.
            let names: [(NSNotification.Name, String)] = [
                (NSWindow.didBecomeKeyNotification, "didBecomeKey"),
                (NSWindow.didResizeNotification, "didResize"),
                (NSWindow.didBecomeMainNotification, "didBecomeMain"),
            ]
            for (name, reason) in names {
                let token = center.addObserver(
                    forName: name,
                    object: window,
                    queue: .main
                ) { [weak self, weak window] _ in
                    guard let self, let window else { return }
                    self.reassertFullScreen(on: window, reason: reason, logger: logger)
                }
                observerTokens.append(token)
            }

            // Initial assertion at install time.
            reassertFullScreen(on: window, reason: "install", logger: logger)
        }

        private func removeObservers() {
            let center = NotificationCenter.default
            for token in observerTokens {
                center.removeObserver(token)
            }
            observerTokens.removeAll()
            boundWindow = nil
            loggedConfirmation = false
        }
    }
}
