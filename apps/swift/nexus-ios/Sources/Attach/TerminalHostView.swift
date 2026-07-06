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
    /// Back-pop teardown bridge (nx-km2um). AttachScene owns this and fires it
    /// from `.onDisappear`; we point it at the coordinator's `disconnect()` so
    /// the pop closes both PTY sockets promptly instead of waiting on the
    /// laggy dismantleUIView path.
    let teardown: AttachTeardown

    func makeUIView(context: Context) -> PhoneTerminalView {
        let view = PhoneTerminalView()
        view.terminalDelegate = context.coordinator
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

        let b = view.bounds
        ptyHostLog.debug("nx-rkir6 makeUIView bounds=\(b.width, privacy: .public)x\(b.height, privacy: .public) grid=\(view.getTerminal().cols, privacy: .public)x\(view.getTerminal().rows, privacy: .public)")

        Task { @MainActor in
            await context.coordinator.connect(
                session: session,
                tmuxTarget: tmuxTarget,
                view: view
            )
            // Claim focus once wired so the keyboard + accessory present.
            _ = view.becomeFirstResponder()
        }
        return view
    }

    func updateUIView(_ uiView: PhoneTerminalView, context: Context) {}

    static func dismantleUIView(_ uiView: PhoneTerminalView, coordinator: SshTerminalSession) {
        coordinator.disconnect()
    }

    func makeCoordinator() -> SshTerminalSession {
        SshTerminalSession(statusBinding: $status, client: client)
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
