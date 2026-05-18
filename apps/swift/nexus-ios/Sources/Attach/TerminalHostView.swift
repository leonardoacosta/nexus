// TerminalHostView — SwiftTerm UIView bridge.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
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
    @Binding var status: AttachStatus

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView()
        view.terminalDelegate = context.coordinator
        Task { @MainActor in
            await context.coordinator.connect(
                session: session,
                tmuxTarget: tmuxTarget,
                view: view
            )
        }
        return view
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {}

    func makeCoordinator() -> SshTerminalSession {
        SshTerminalSession(statusBinding: $status)
    }
}

#else

// Placeholder host when SwiftTerm isn't resolved yet (e.g., CI without
// SPM resolution). Lets the file compile while signalling the missing
// dependency at runtime.
struct TerminalHostView: View {
    let session: Session
    let tmuxTarget: String
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
