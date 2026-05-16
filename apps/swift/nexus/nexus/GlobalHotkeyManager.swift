//
//  GlobalHotkeyManager.swift
//  nexus
//
//  Wraps `RegisterEventHotKey` (Carbon.framework) for `⌃⌥N` (summon) and
//  `⌃⌥H` (spawn homelab session). Per design.md §A5 we use the direct Carbon
//  API rather than pulling in an SPM dependency.
//

import AppKit
import Carbon.HIToolbox

@MainActor
final class GlobalHotkeyManager {
    static let shared = GlobalHotkeyManager()

    private var installed = false
    private var summonRef: EventHotKeyRef?
    private var spawnRef: EventHotKeyRef?
    private weak var viewModel: NexusViewModel?

    private init() {}

    /// Idempotent — safe to call from NexusPanel.onAppear.
    func installIfNeeded(viewModel: NexusViewModel) {
        if installed { return }
        self.viewModel = viewModel
        installEventHandler()
        registerHotkeys()
        installed = true
    }

    func reset() {
        if let r = summonRef { UnregisterEventHotKey(r); summonRef = nil }
        if let r = spawnRef { UnregisterEventHotKey(r); spawnRef = nil }
        installed = false
    }

    // ── Carbon plumbing ────────────────────────────────────────────────

    private func installEventHandler() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: OSType(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, eventRef, userData -> OSStatus in
            guard let eventRef = eventRef else { return noErr }
            var hkID = EventHotKeyID()
            let err = GetEventParameter(
                eventRef,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hkID
            )
            guard err == noErr else { return err }
            // Bounce out of the C callback onto MainActor.
            DispatchQueue.main.async {
                GlobalHotkeyManager.shared.handle(signature: hkID.signature, id: hkID.id)
            }
            return noErr
        }, 1, &spec, nil, nil)
    }

    private func registerHotkeys() {
        // ⌃⌥N — summon panel
        let summonId = EventHotKeyID(signature: fourCharCode("nexS"), id: 1)
        RegisterEventHotKey(
            UInt32(kVK_ANSI_N),
            UInt32(controlKey | optionKey),
            summonId,
            GetApplicationEventTarget(),
            0,
            &summonRef
        )
        // ⌃⌥H — spawn homelab session
        let spawnId = EventHotKeyID(signature: fourCharCode("nexH"), id: 2)
        RegisterEventHotKey(
            UInt32(kVK_ANSI_H),
            UInt32(controlKey | optionKey),
            spawnId,
            GetApplicationEventTarget(),
            0,
            &spawnRef
        )
    }

    private func handle(signature: OSType, id: UInt32) {
        switch id {
        case 1: summonPanel()
        case 2: spawnHomelabSession()
        default: break
        }
    }

    // ── Actions ────────────────────────────────────────────────────────

    private func summonPanel() {
        // Activate the app — MenuBarExtra will show the panel on next
        // status-item click. Programmatic opening of the MenuBarExtra popover
        // is not exposed in SwiftUI, so we approximate by activating + asking
        // the system to expose the menu bar item.
        NSApp.activate(ignoringOtherApps: true)
        // Toggle a hidden popover anchor: AppKit doesn't give a direct API,
        // but `NSStatusItem` invokes the click action. Searching the AppKit
        // bar items list for our extra is the standard escape hatch.
        if let extra = NSApp.windows.first(where: { $0.className.contains("MenuBarExtra") }) {
            extra.makeKeyAndOrderFront(nil)
        }
    }

    private func spawnHomelabSession() {
        guard let vm = viewModel else { return }
        Task {
            await SpawnHomelabSession.run(viewModel: vm)
        }
    }
}

// MARK: - Helpers

private func fourCharCode(_ s: String) -> OSType {
    var code: OSType = 0
    for c in s.utf8.prefix(4) {
        code = (code << 8) | OSType(c)
    }
    return code
}
