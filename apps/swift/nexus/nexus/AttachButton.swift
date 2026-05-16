//
//  AttachButton.swift
//  nexus
//
//  Resolves the selected session's tmux window name, then shells out to
//  Ghostty via `/usr/bin/open`. See design.md §A3 for the exact argv shape
//  (test 2.1 asserts byte-for-byte equivalence).
//

import SwiftUI

struct AttachButton: View {
    @EnvironmentObject private var vm: NexusViewModel
    @State private var launchError: String?

    var body: some View {
        Button(action: launch) {
            VStack(spacing: 4) {
                Image(systemName: "terminal")
                    .font(.system(size: 14, weight: .semibold))
                Text("ATTACH")
                    .font(.jbm(9, weight: .medium))
                    .tracking(1.4)
            }
            .foregroundStyle(isEnabled ? Color.nx.ink : Color.nx.ink3)
            .opacity(isEnabled ? 1 : 0.4)
        }
        .buttonStyle(.plain)
        .modifier(ActionButtonStyle())
        .disabled(!isEnabled)
        .help("Attach to highlighted session (↩)")
        .alert("Attach failed", isPresented: Binding(
            get: { launchError != nil },
            set: { if !$0 { launchError = nil } }
        )) {
            Button("OK", role: .cancel) { launchError = nil }
            Button("Open App Store") {
                NSWorkspace.shared.open(URL(string: "macappstore://apps.apple.com/")!)
                launchError = nil
            }
        } message: {
            Text(launchError ?? "")
        }
    }

    private var isEnabled: Bool { vm.selectedSession != nil }

    private func launch() {
        guard let s = vm.selectedSession else { return }
        do {
            try GhosttyLauncher.attach(window: s.resolvedTmuxWindow)
        } catch {
            launchError = "Ghostty.app not found at /Applications/Ghostty.app"
        }
    }
}

// MARK: - Launcher (extracted for testability — see GhosttyLauncherTests)

enum GhosttyLauncherError: Error {
    case launchFailed(Error)
}

/// The exact argv pinned by design.md §A3. The launcher invokes
/// `/usr/bin/open -na Ghostty.app --args -e "ssh -t nyaptor@homelab tmux
/// attach \; select-window -t <name>"`.
enum GhosttyLauncher {
    static let executable = "/usr/bin/open"
    static let bundleName = "Ghostty.app"

    /// Compose the argv array used by `Process()`. Pure function — tested in
    /// `GhosttyLauncherTests`.
    static func arguments(forWindow window: String, user: String = "nyaptor", host: String = "homelab") -> [String] {
        let sshCommand = "ssh -t \(user)@\(host) tmux attach \\; select-window -t \(window)"
        return ["-na", bundleName, "--args", "-e", sshCommand]
    }

    /// Compose argv for spawning a fresh session — opens Ghostty on the
    /// new tmux window directly (the agent already ran `claude` for us).
    static func attach(window: String, user: String = "nyaptor", host: String = "homelab") throws {
        let args = arguments(forWindow: window, user: user, host: host)
        try run(args)
    }

    private static func run(_ args: [String]) throws {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: executable)
        proc.arguments = args
        do {
            try proc.run()
        } catch {
            throw GhosttyLauncherError.launchFailed(error)
        }
    }
}
