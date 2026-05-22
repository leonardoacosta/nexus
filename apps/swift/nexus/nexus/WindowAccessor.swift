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
//
// Usage:
//   AppNavigation()
//     .background(WindowAccessor { window in
//       window.collectionBehavior.insert(.fullScreenPrimary)
//     })
//
// The view itself is zero-size and invisible; only side effects on the
// resolved NSWindow matter.

import AppKit
import SwiftUI

struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        // Defer to the next runloop tick so `view.window` is non-nil —
        // the NSView is not yet attached to the window hierarchy inside
        // `makeNSView`. DispatchQueue.main.async is the canonical
        // SwiftUI→AppKit window-resolution hop.
        DispatchQueue.main.async {
            if let window = view.window {
                onWindow(window)
            }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
