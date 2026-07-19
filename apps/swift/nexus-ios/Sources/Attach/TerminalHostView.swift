// TerminalHostView — SwiftTerm UIView bridge.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
// bd:mx-rkir.3 — live PTY attach (no longer a stub).
// bd:mx-rkir.6 — keyboard input + post-layout phone-driven sizing + redraw.
//
// SwiftTerm is added as an SPM dependency in apps/swift/project.yml.
// This file imports it via `#if canImport(SwiftTerm)` so the source tree
// still compiles before the package is resolved (Xcode cold-checkout).

import SwiftUI
import NexusShared
import os
#if canImport(UIKit)
import UIKit
#endif
#if canImport(SwiftTerm)
import SwiftTerm
#endif

#if canImport(UIKit) && canImport(SwiftTerm)

private let ptyHostLog = Logger(subsystem: "dev.priceless.nexus", category: "PtyHostIOS")

/// Diagnostic PTY logger (mx-rkir.6/.8) — `.notice` so it streams via
/// `devicectl device console`; grep tag `NXPTY`.
private let nxptyLog = Logger(subsystem: "dev.priceless.nexus", category: "pty")

/// SwiftTerm `TerminalView` subclass that reports EVERY settled layout pass.
///
/// ROOT-CAUSE FIX (mx-rkir.6): a bare `TerminalView` built with `TerminalView()`
/// runs `setupOptions(width:height:)` against `bounds == .zero` at init, so the
/// emulator starts as a 0x0 (then, post-layout, an UNCORRELATED) grid. The
/// previous fix tried to read `getTerminal().cols/rows` on a fixed 300ms timer,
/// which races the first real `layoutSubviews` — when layout hadn't run yet the
/// grid was still 0, the resize was guarded out, and tmux kept its ~200-col Mac
/// geometry. The phone then rendered a 200-col grid into a ~50-col view: the
/// dense micro-grid garble. Keyboard show/hide reflowed bounds and re-garbled.
///
/// By overriding `layoutSubviews` we get a deterministic signal AFTER UIKit has
/// given the view a non-zero frame. We hand the SETTLED bounds + the freshly
/// recomputed cols/rows to the session, which drives tmux to match and forces a
/// repaint. This fires on first layout, rotation, AND keyboard frame change —
/// exactly the moments that previously garbled.
final class PhoneTerminalView: SwiftTerm.TerminalView {
    /// Called on every layout pass where bounds has a real (non-zero) width.
    /// Passes the settled cols/rows (SwiftTerm has already reflowed its own
    /// grid in `super.layoutSubviews()` via `processSizeChange`).
    var onSettledLayout: ((_ cols: Int, _ rows: Int, _ bounds: CGRect) -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        let b = bounds
        guard b.width > 1, b.height > 1 else {
            ptyHostLog.debug("nx-rkir6 layout SKIP bounds=\(b.width, privacy: .public)x\(b.height, privacy: .public) (zero/placeholder)")
            return
        }
        let term = getTerminal()
        let cols = term.cols
        let rows = term.rows
        // Derive cell metrics from the public optimal-frame API (cellDimension
        // is internal to SwiftTerm and not visible from this module).
        let optimal = getOptimalFrameSize()
        let cellW = cols > 0 ? optimal.width / CGFloat(cols) : 0
        let cellH = rows > 0 ? optimal.height / CGFloat(rows) : 0
        ptyHostLog.debug("nx-rkir6 layout bounds=\(b.width, privacy: .public)x\(b.height, privacy: .public) cellW=\(cellW, privacy: .public) cellH=\(cellH, privacy: .public) grid=\(cols, privacy: .public)x\(rows, privacy: .public)")
        nxptyLog.notice("NXPTY layout bounds=\(Int(b.width), privacy: .public)x\(Int(b.height), privacy: .public) cell=\(String(format: "%.1f", cellW), privacy: .public)x\(String(format: "%.1f", cellH), privacy: .public) computedGrid=\(cols, privacy: .public)x\(rows, privacy: .public)")
        onSettledLayout?(cols, rows, b)
    }

    // SWIPE-TO-PAGE (swipe-to-page-terminal-ios): touch-native equivalent of the
    // accessory bar's pgup/pgdn buttons. `pageUp()`/`pageDown()` are public on the
    // SwiftTerm `TerminalView` superclass and ALREADY alt-screen-aware — they send
    // the PgUp/PgDn escape sequence to the remote app in alt-screen mode, or scroll
    // the local buffer directly otherwise. These `@objc` wrappers exist because the
    // SwiftTerm methods aren't `@objc`-exposed and so can't be gesture selectors
    // directly; they add no logic beyond forwarding. Hosted on the view (not the
    // coordinator) so no `SshTerminalSession.swift` change is needed.
    // Direction: swipe DOWN reveals older content (pageUp), swipe UP reveals newer
    // content (pageDown) — content-follows-finger.
    @objc func handleSwipeDown(_ recognizer: UISwipeGestureRecognizer) {
        pageUp()
    }

    @objc func handleSwipeUp(_ recognizer: UISwipeGestureRecognizer) {
        pageDown()
    }
}

struct TerminalHostView: UIViewRepresentable {
    let session: Session
    let tmuxTarget: String
    /// Shared aggregate transport from the app's SessionObserver — the live
    /// PTY attach reuses the same client (and resolved endpoint) the rest of
    /// the iOS app talks to. Threaded in (not constructed) so we never spin up
    /// a second endpoint-resolution path.
    let client: NexusAggregateClient
    @Binding var status: AttachStatus
    /// Keyboard overlap height (points) the coordinator publishes from the
    /// keyboard-frame notifications (nx-eqpvh). AttachScene shrinks the terminal
    /// by this amount so the live cursor/prompt row stays above the keyboard.
    @Binding var keyboardOverlap: CGFloat
    /// Back-pop teardown bridge (nx-km2um). AttachScene owns this and fires it
    /// from `.onDisappear`; we point it at the coordinator's `disconnect()` so
    /// the pop closes both PTY sockets promptly instead of waiting on the
    /// laggy dismantleUIView path.
    let teardown: AttachTeardown

    func makeUIView(context: Context) -> PhoneTerminalView {
        let view = PhoneTerminalView()
        view.terminalDelegate = context.coordinator

        // RENDER FIX (nx-ywqig.1): defeat the double-exposure garble where every
        // terminal frame stacks on top of the prior one instead of replacing it.
        //
        // ROOT CAUSE: SwiftTerm's iOS `setupOptions()` sets
        // `nativeBackgroundColor = UIColor.clear` (after stashing the real bg on
        // `layer.backgroundColor`). Its `draw(_:)` then "erases" each frame with
        // `nativeBackgroundColor.set(); context.fill([dirtyRect])` — i.e. it fills
        // the dirty rect with TRANSPARENT and leans entirely on two fragile
        // things to cover the previous frame: the opaque `layer.backgroundColor`
        // backdrop AND UIKit clearing the backing store before `draw`. Inside this
        // scroll-locked, full-bleed (`ignoresSafeArea`) SwiftUI host that
        // transparent-erase path does NOT reliably cover the prior frame, so
        // successive redraws composite → the multiple-exposure smear.
        //
        // macOS never hits this: its `nativeBackgroundColor` stays OPAQUE
        // (`NSColor.textBackgroundColor`), so every `draw` fills the dirty rect
        // with a solid colour and fully erases the last frame. Mirror that here —
        // restore an OPAQUE `nativeBackgroundColor` (the exact colour
        // `setupOptions` already put on the layer backdrop) so `draw`'s
        // `context.fill([dirtyRect])` performs a real opaque erase before glyphs
        // are drawn. `updateDisplay` invalidates the full `bounds` each frame, so
        // the opaque fill wipes the whole visible pane every redraw.
        if let backdrop = view.layer.backgroundColor {
            view.nativeBackgroundColor = UIColor(cgColor: backdrop)
        }
        // FIX A (mx-rkir.6): without first-responder the system keyboard +
        // SwiftTerm's built-in TerminalAccessory (esc/ctrl/tab/arrows/~|/-)
        // never appear, so you can't type. SwiftTerm routes every keystroke
        // through terminalDelegate.send(source:data:) → SshTerminalSession
        // forwards it to /interact. Enable interaction + claim focus, and
        // add a tap recognizer so tapping the terminal re-focuses it after
        // the keyboard is dismissed.
        view.isUserInteractionEnabled = true
        let tap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(SshTerminalSession.handleFocusTap)
        )
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)

        // SWIPE-TO-PAGE (swipe-to-page-terminal-ios): two swipe recognizers calling
        // the view's own `pageUp()`/`pageDown()` (public on SwiftTerm's TerminalView,
        // alt-screen-aware — see PhoneTerminalView.handleSwipe* wrappers). Targets the
        // view, not the coordinator, so no SshTerminalSession change. Swipe DOWN =
        // pageUp (older content), swipe UP = pageDown (newer content). Swipe and the
        // existing tap recognize different gesture shapes, so they coexist by default
        // in UIKit with no UIGestureRecognizerDelegate simultaneous-recognition tuning
        // (nx-685zl). `cancelsTouchesInView = false` mirrors the tap so keystroke
        // touches still reach SwiftTerm.
        let swipeDown = UISwipeGestureRecognizer(
            target: view,
            action: #selector(PhoneTerminalView.handleSwipeDown(_:))
        )
        swipeDown.direction = .down
        swipeDown.cancelsTouchesInView = false
        view.addGestureRecognizer(swipeDown)

        let swipeUp = UISwipeGestureRecognizer(
            target: view,
            action: #selector(PhoneTerminalView.handleSwipeUp(_:))
        )
        swipeUp.direction = .up
        swipeUp.cancelsTouchesInView = false
        view.addGestureRecognizer(swipeUp)

        // KEYBOARD-AWARE RESIZE (nx-eqpvh): observe keyboard show/hide so the
        // coordinator can publish the overlap height. AttachScene consumes it to
        // shrink the terminal's height (nx-wwoot); the resulting bounds change
        // drives PhoneTerminalView.layoutSubviews -> handleSettledLayout on the
        // SAME path rotation uses, and that resize is debounced in
        // SshTerminalSession (nx-gmes8). Torn down in dismantleUIView.
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(SshTerminalSession.keyboardWillShow(_:)),
            name: UIResponder.keyboardWillShowNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(SshTerminalSession.keyboardWillHide(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )

        // SCROLL LOCK (mx-rkir.11): SwiftTerm's `TerminalView` IS a UIScrollView
        // (see SwiftTerm/iOS/iOSTerminalView.swift: `open class TerminalView:
        // UIScrollView`). Scrolling SwiftTerm's local scrollback while tmux is in
        // ALT-SCREEN mode (the claude-code TUI) exposes stale buffer rows tmux is
        // actively redrawing over → colored noise/garble. SwiftTerm still updates
        // `contentOffset` PROGRAMMATICALLY on each feed (it pins to the bottom/live
        // region), so the live pane keeps rendering full-bleed — only USER scroll
        // is what risks revealing stale scrollback.
        //
        // CONDITIONAL SCROLL (conditional-scroll-non-altscreen-ios): the lock is no
        // longer blanket. `SshTerminalSession.applyScrollLockState` re-evaluates it
        // live — scroll is enabled ONLY when the keyboard is down AND the session is
        // NOT in alt-screen mode; alt-screen sessions stay locked at all times.
        // START LOCKED (safe default): the coordinator flips it on once the first
        // buffer update / keyboard event re-evaluates the combined condition.
        // `notifyUpdateChanges = true` makes SwiftTerm fire the delegate's
        // `rangeChanged(source:startY:endY:)` on buffer visual changes, which is how
        // the coordinator detects alt-screen enter/exit reactively (no dedicated
        // buffer-swap delegate hook exists).
        view.notifyUpdateChanges = true
        view.isScrollEnabled = false
        view.bounces = false
        view.alwaysBounceVertical = false
        view.alwaysBounceHorizontal = false
        view.showsVerticalScrollIndicator = false
        view.showsHorizontalScrollIndicator = false
        view.contentInsetAdjustmentBehavior = .never

        // POST-LAYOUT SIZING (mx-rkir.6): drive tmux from the SETTLED grid, not
        // a racy timer. PhoneTerminalView reports cols/rows on every non-zero
        // layout (first layout, rotation, keyboard show/hide).
        view.onSettledLayout = { [weak coordinator = context.coordinator] cols, rows, bounds in
            coordinator?.handleSettledLayout(cols: cols, rows: rows, bounds: bounds)
        }

        // nx-km2um: wire the back-pop teardown to this coordinator's disconnect()
        // (closes both the PTY stream WS and the interact WS, idempotent). Fired
        // by AttachScene.onDisappear on NavigationStack pop.
        teardown.disconnect = { [weak coordinator = context.coordinator] in
            coordinator?.disconnect()
        }

        // keyboard-aware-terminal-resize-ios follow-up: wire the nav-bar dismiss
        // button to the coordinator's dismissKeyboard() — resigns first responder
        // on the LIVE terminal view. SAME ungated->gated bridge as disconnect
        // above; replaces AttachScene's old sendAction(nil) responder-chain trick,
        // which never reached the terminal on-device.
        teardown.dismissKeyboard = { [weak coordinator = context.coordinator] in
            coordinator?.dismissKeyboard()
        }

        let b = view.bounds
        ptyHostLog.debug("nx-rkir6 makeUIView bounds=\(b.width, privacy: .public)x\(b.height, privacy: .public) grid=\(view.getTerminal().cols, privacy: .public)x\(view.getTerminal().rows, privacy: .public)")

        Task { @MainActor in
            await context.coordinator.connect(
                session: session,
                tmuxTarget: tmuxTarget,
                view: view
            )
            // Claim focus once wired so the keyboard + accessory present.
            // mx-rkir.11: this view is pushed onto the Sessions NavigationStack
            // (RootScene), so it can still be mid-transition when the connect
            // Task resumes. Only a view that's actually in the window hierarchy
            // can become first responder, so guard on `window != nil` and retry
            // once on the next runloop if the push animation hasn't settled.
            if view.window != nil {
                _ = view.becomeFirstResponder()
            } else {
                DispatchQueue.main.async { _ = view.becomeFirstResponder() }
            }
        }
        return view
    }

    func updateUIView(_ uiView: PhoneTerminalView, context: Context) {}

    static func dismantleUIView(_ uiView: PhoneTerminalView, coordinator: SshTerminalSession) {
        coordinator.teardownKeyboard()
        coordinator.disconnect()
    }

    func makeCoordinator() -> SshTerminalSession {
        SshTerminalSession(statusBinding: $status, client: client, keyboardOverlap: $keyboardOverlap)
    }
}

#else

// Placeholder host when SwiftTerm isn't resolved yet (e.g., CI without
// SPM resolution). Lets the file compile while signalling the missing
// dependency at runtime.
struct TerminalHostView: View {
    let session: Session
    let tmuxTarget: String
    let client: NexusAggregateClient
    @Binding var status: AttachStatus
    /// Unused in the placeholder (no coordinator to publish it) — present so the
    /// call site in AttachScene is identical across the SwiftTerm #if.
    @Binding var keyboardOverlap: CGFloat
    /// Unused in the placeholder (no coordinator to wire) — present so the
    /// call site in AttachScene is identical across the SwiftTerm #if.
    let teardown: AttachTeardown

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 40))
            Text("SwiftTerm not linked")
                .font(.headline)
            Text("Resolve SPM dependencies (xcodegen + Xcode).")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .onAppear { status = .failed("SwiftTerm package not resolved") }
    }
}

#endif
