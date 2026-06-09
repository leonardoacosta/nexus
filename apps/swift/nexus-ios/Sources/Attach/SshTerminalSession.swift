// PtyTerminalSession — owns the live PTY attach that backs SwiftTerm on iOS.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
// bd:mx-rkir.3 — make a notification tap open the LIVE tmux PTY.
//
// REUSE NOTE: this mirrors the macOS PtyViewer transport
// (nexus-mac/Sources/Dashboard/PtyViewer.swift → PtyViewerModel) byte-for-byte.
// macOS does NOT use SSH for the terminal — it streams the agent's WebSocket
// PTY via NexusShared.NexusAggregateClient:
//   • output  : consumePtyStream(sessionId:)  → .bytes / .geometry events
//   • input   : openInteract / sendInteractiveInput / closeInteract  (WS /interact)
//   • resize  : requestResize(sessionId:cols:rows:)  (POST /commands/resize)
// The client lives in NexusShared, so iOS reuses it directly — no SSH stack,
// no parallel PTY protocol. The previous banner stub never connected; this
// coordinator drives a real attach end-to-end.

import Foundation
import SwiftUI
import NexusShared
#if canImport(UIKit)
import UIKit
#endif
#if canImport(SwiftTerm)
import SwiftTerm
#endif

#if canImport(SwiftTerm)

@MainActor
final class SshTerminalSession: NSObject, @preconcurrency TerminalViewDelegate {
    @Binding var status: AttachStatus

    /// Shared aggregate transport — the SAME client the rest of the iOS app
    /// reads sessions/health through (resolved Nexus endpoint, homelab:7400
    /// over Tailscale). Reusing it means the PTY attach hits the exact peer
    /// the dashboard already talks to; no second endpoint resolution.
    private let client: NexusAggregateClient

    private var sessionId: String = ""
    /// Gate input forwarding on managed sessions (parity with PtyViewerModel) —
    /// non-managed (raw/ad_hoc) sessions have no tmux pane to write into.
    private var sessionType: String?
    private var isManaged: Bool { sessionType == "managed" }
    /// Owning agent for this session — used to route interact/resize/close to
    /// the right peer and to tear down the channel on detach (the session may
    /// be gone from the observer by then, so we capture it at connect time).
    private var originAgent: String?

    private weak var terminal: TerminalView?
    /// Bytes received before SwiftTerm is attached are buffered and drained on
    /// first attach (the stream can beat the view-mount Task).
    private var preAttachBuffer: [UInt8] = []
    private var streamTask: Task<Void, Never>?
    /// Connect-window watchdog: no bytes within the budget ⇒ stale session id
    /// (agent restart / session ended) ⇒ surface `.failed` so the badge flips.
    private var connectWatchdog: Task<Void, Never>?
    private let connectTimeoutSeconds: UInt64 = 6
    private var sawFirstByte = false

    init(statusBinding: Binding<AttachStatus>, client: NexusAggregateClient) {
        self._status = statusBinding
        self.client = client
        super.init()
    }

    // MARK: - Connect / disconnect

    func connect(session: Session, tmuxTarget: String, view: TerminalView) async {
        self.sessionId = session.id
        self.sessionType = session.sessionType
        self.originAgent = session.agent
        self.terminal = view
        status = .connecting
        sawFirstByte = false

        // Drain anything that arrived before the view mounted.
        if !preAttachBuffer.isEmpty {
            view.feed(byteArray: ArraySlice(preAttachBuffer))
            preAttachBuffer.removeAll(keepingCapacity: false)
        }

        // Open the raw-input WS channel for managed sessions so keystrokes
        // write raw bytes (no tmux send-keys Enter append). Best-effort: a
        // 4009 writer-denied close flips the channel read-only internally.
        if isManaged {
            await client.openInteract(sessionId: session.id, originAgent: session.agent)
        }

        let sid = session.id
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.client.consumePtyStream(sessionId: sid) { [weak self] event in
                switch event {
                case .bytes(let data):
                    await self?.feed(data: data)
                case .geometry(let cols, let rows):
                    await self?.applyGeometry(cols: cols, rows: rows)
                }
            }
            // Stream ended. If we never errored, mark it failed so the user
            // knows the live pane dropped (vs. a momentary blip).
            await MainActor.run { [weak self] in
                guard let self else { return }
                if case .connecting = self.status {
                    self.status = .failed("PTY stream ended")
                } else if self.sawFirstByte {
                    self.status = .failed("PTY stream disconnected")
                }
            }
        }

        // Watchdog: still .connecting after the budget ⇒ stale session id.
        connectWatchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: (self?.connectTimeoutSeconds ?? 6) * 1_000_000_000)
            guard let self else { return }
            if Task.isCancelled { return }
            if case .connecting = self.status {
                self.status = .failed("Stream connect timeout — session may have ended")
            }
        }
    }

    func disconnect() {
        streamTask?.cancel(); streamTask = nil
        connectWatchdog?.cancel(); connectWatchdog = nil
        let client = self.client
        let origin = originAgent
        Task { await client.closeInteract(originAgent: origin) }
    }

    private func feed(data: Data) async {
        connectWatchdog?.cancel(); connectWatchdog = nil
        sawFirstByte = true
        status = .connected
        let bytes = [UInt8](data)
        let slice = ArraySlice(bytes)
        if let terminal {
            terminal.feed(byteArray: slice)
        } else {
            preAttachBuffer.append(contentsOf: bytes)
            if preAttachBuffer.count > 1_000_000 {
                preAttachBuffer.removeFirst(preAttachBuffer.count - 1_000_000)
            }
        }
    }

    /// Pin the SwiftTerm grid to the agent-reported pane geometry so ANSI
    /// cursor escapes land in the right cells (lock mode — no tmux mutation).
    private func applyGeometry(cols: Int, rows: Int) async {
        guard cols > 0, rows > 0 else { return }
        terminal?.getTerminal().resize(cols: cols, rows: rows)
    }

    // MARK: - TerminalViewDelegate

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        // Forward raw keystroke bytes over the interact channel. No-op for
        // non-managed sessions (no tmux target). Fire-and-forget so the
        // terminal never blocks on the network.
        guard isManaged else { return }
        let payload = Data(data)
        let origin = originAgent
        Task { [client] in
            await client.sendInteractiveInput(payload, originAgent: origin)
        }
    }

    /// SwiftTerm reflowed (keyboard/rotation changed the grid) — forward the
    /// new size to the agent so the tmux pane matches. Managed-gated.
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard isManaged, newCols > 0, newRows > 0 else { return }
        let sid = sessionId
        let origin = originAgent
        Task { [client] in
            try? await client.requestResize(sessionId: sid, cols: newCols, rows: newRows, originAgent: origin)
        }
    }

    func scrolled(source: TerminalView, position: Double) {}
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String : String]) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func bell(source: TerminalView) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#endif
