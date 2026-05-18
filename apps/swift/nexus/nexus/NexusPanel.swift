//
//  NexusPanel.swift
//  nexus
//
//  Root popover view shown by `MenuBarExtra(.window)`. 320pt wide VStack with
//  six locked regions per spec § "Panel summons via click or global hotkey".
//

import SwiftUI

struct NexusPanel: View {
    @EnvironmentObject private var vm: NexusViewModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hotkeys = GlobalHotkeyManager.shared

    var body: some View {
        ZStack {
            HudBackdrop()
            VStack(spacing: 0) {
                IdentityRow()
                if vm.alert != nil { AlertStrip() }
                MetricsRow()
                SessionList()
                ActionRow()
            }
        }
        .frame(width: 320)
        .background(Color.nx.substrate2)
        .onAppear {
            vm.startStreams()
            hotkeys.installIfNeeded(viewModel: vm)
            AutostartInstaller.firstRunPromptIfNeeded()
        }
        .onDisappear {
            // Streams stay alive — the menu bar app is meant to persist.
        }
        .environment(\.layoutDirection, .leftToRight)
        .font(.jbm(12))
        .foregroundStyle(Color.nx.ink)
        .keyboardShortcuts(viewModel: vm)
    }
}

// MARK: - Backdrop (NSVisualEffectView wrap per design.md §A7)

struct HudBackdrop: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        v.isEmphasized = false
        return v
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

// MARK: - Keyboard shortcuts modifier

private struct PanelKeyboardShortcuts: ViewModifier {
    @ObservedObject var viewModel: NexusViewModel
    @Environment(\.openWindow) private var openWindow
    func body(content: Content) -> some View {
        content
            // ⌘D open full dashboard window.
            .background(
                Button("") {
                    openWindow(id: "dashboard")
                }
                .keyboardShortcut("d", modifiers: .command)
                .hidden()
            )
            // ⌘M mute toggle.
            .background(
                Button("") {
                    Task { await viewModel.toggleTtsMute() }
                }
                .keyboardShortcut("m", modifiers: .command)
                .hidden()
            )
            // ⌘T test voice.
            .background(
                Button("") {
                    Task { await viewModel.testVoice() }
                }
                .keyboardShortcut("t", modifiers: .command)
                .hidden()
            )
            // ⌘, preferences.
            .background(
                Button("") {
                    NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                }
                .keyboardShortcut(",", modifiers: .command)
                .hidden()
            )
            // ↩ attach selected session.
            .background(
                Button("") {
                    if let session = viewModel.selectedSession {
                        try? GhosttyLauncher.attach(window: session.resolvedTmuxWindow)
                    }
                }
                .keyboardShortcut(.return, modifiers: [])
                .hidden()
            )
            // ↓ next session.
            .background(
                Button("") {
                    let homelab = viewModel.homelabSessions
                    guard let current = viewModel.selectedSessionId,
                          let idx = homelab.firstIndex(where: { $0.id == current })
                    else {
                        viewModel.selectSession(id: homelab.first?.id)
                        return
                    }
                    let next = homelab[min(idx + 1, homelab.count - 1)]
                    viewModel.selectSession(id: next.id)
                }
                .keyboardShortcut(.downArrow, modifiers: [])
                .hidden()
            )
            // ↑ previous session.
            .background(
                Button("") {
                    let homelab = viewModel.homelabSessions
                    guard let current = viewModel.selectedSessionId,
                          let idx = homelab.firstIndex(where: { $0.id == current })
                    else {
                        viewModel.selectSession(id: homelab.last?.id)
                        return
                    }
                    let prev = homelab[max(idx - 1, 0)]
                    viewModel.selectSession(id: prev.id)
                }
                .keyboardShortcut(.upArrow, modifiers: [])
                .hidden()
            )
            // Esc dismiss.
            .background(
                Button("") {
                    NSApp.deactivate()
                }
                .keyboardShortcut(.escape, modifiers: [])
                .hidden()
            )
    }
}

private extension View {
    func keyboardShortcuts(viewModel: NexusViewModel) -> some View {
        modifier(PanelKeyboardShortcuts(viewModel: viewModel))
    }
}
