// TerminalHostView — SwiftTerm UIView bridge.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
// bd:mx-rkir.3 — live PTY attach (no longer a stub).
//
// SwiftTerm is added as an SPM dependency in apps/swift/project.yml.
// This file imports it via `#if canImport(SwiftTerm)` so the source tree
// still compiles before the package is resolved (Xcode cold-checkout).

import SwiftUI
import NexusShared
#if canImport(UIKit)
import UIKit
#endif
#if canImport(SwiftTerm)
import SwiftTerm
#endif

#if canImport(UIKit) && canImport(SwiftTerm)

struct TerminalHostView: UIViewRepresentable {
    let session: Session
    let tmuxTarget: String
    /// Shared aggregate transport from the app's SessionObserver — the live
    /// PTY attach reuses the same client (and resolved endpoint) the rest of
    /// the iOS app talks to. Threaded in (not constructed) so we never spin up
    /// a second endpoint-resolution path.
    let client: NexusAggregateClient
    @Binding var status: AttachStatus

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView()
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

    func updateUIView(_ uiView: TerminalView, context: Context) {}

    static func dismantleUIView(_ uiView: TerminalView, coordinator: SshTerminalSession) {
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
