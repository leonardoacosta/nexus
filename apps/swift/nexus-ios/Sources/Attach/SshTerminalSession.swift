// PtyTerminalSession — owns the live PTY attach that backs SwiftTerm on iOS.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
// bd:mx-rkir.3 — make a notification tap open the LIVE tmux PTY.
// bd:mx-rkir.6 — keyboard input + post-layout phone-driven sizing + redraw.
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
//
// SIZING DIFFERENCE vs macOS (mx-rkir.6): macOS uses LOCK mode — it resizes the
// LOCAL SwiftTerm grid to the AGENT's reported geometry and letterboxes. iOS
// does the inverse: the PHONE owns its (narrow) grid and DRIVES tmux to it. So
// `applyGeometry` is a deliberate no-op here, and sizing is driven from a real
// layout pass (PhoneTerminalView.layoutSubviews → handleSettledLayout), not the
// agent's desktop-width geometry frame.

import Foundation
import SwiftUI
import NexusShared
import os
#if canImport(UIKit)
import UIKit
#endif
#if canImport(SwiftTerm)
import SwiftTerm
#endif

#if canImport(SwiftTerm)

private let ptySessionLog = Logger(subsystem: "dev.priceless.nexus", category: "PtySessionIOS")

/// Diagnostic PTY logger (mx-rkir.6/.8) — `.notice` so it streams via
/// `devicectl device console`; grep tag `NXPTY`.
private let nxptyLog = Logger(subsystem: "dev.priceless.nexus", category: "pty")

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

    /// Last cols/rows we pushed to tmux. Dedups identical layout passes (UIKit
    /// fires layoutSubviews repeatedly with the same bounds) so we only resize +
    /// redraw on an ACTUAL grid change. Starts at (0,0) so the first real layout
    /// always lands.
    private var lastPushedCols = 0
    private var lastPushedRows = 0
    /// Connected yet? We only forward layout-driven resizes once the interact
    /// channel is open (otherwise the redraw Ctrl-L is dropped). The first
    /// settled layout after connect re-applies the pending grid.
    private var connected = false
    private var pendingGrid: (cols: Int, rows: Int)?

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

        let initialTerm = view.getTerminal()
        ptySessionLog.debug("nx-rkir6 connect sid=\(session.id, privacy: .public) managed=\(self.isManaged, privacy: .public) bounds=\(view.bounds.width, privacy: .public)x\(view.bounds.height, privacy: .public) grid=\(initialTerm.cols, privacy: .public)x\(initialTerm.rows, privacy: .public)")
        nxptyLog.notice("NXPTY connect sid=\(session.id, privacy: .public) managed=\(self.isManaged, privacy: .public) tmux=\(tmuxTarget, privacy: .public) bounds=\(Int(view.bounds.width), privacy: .public)x\(Int(view.bounds.height), privacy: .public) grid=\(initialTerm.cols, privacy: .public)x\(initialTerm.rows, privacy: .public)")

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
            let readOnly = await client.isInteractReadOnly(originAgent: session.agent)
            nxptyLog.notice("NXPTY interact opened sid=\(session.id, privacy: .public) readOnly=\(readOnly, privacy: .public)")
        } else {
            nxptyLog.notice("NXPTY interact skipped sid=\(session.id, privacy: .public) reason=non-managed")
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

        connected = true
        // If a layout already settled before the interact channel opened, apply
        // its grid now (the layout-driven push was deferred until `connected`).
        if isManaged, let pending = pendingGrid {
            ptySessionLog.debug("nx-rkir6 connect drain-pending grid=\(pending.cols, privacy: .public)x\(pending.rows, privacy: .public)")
            pendingGrid = nil
            pushResize(cols: pending.cols, rows: pending.rows, reason: "post-connect")
        }
    }

    /// Settled-layout sizing (mx-rkir.6) — the PHONE drives the grid.
    ///
    /// Called from PhoneTerminalView.layoutSubviews on every layout pass with a
    /// non-zero frame: first layout, rotation, AND keyboard show/hide. SwiftTerm
    /// has already reflowed its own emulator grid to the settled bounds (via
    /// `processSizeChange`), so `cols`/`rows` here are the phone's natural grid.
    /// We forward that to tmux so the pane reflows narrow — replacing the racy
    /// 300ms `forcePhoneResize` timer that read a still-zero grid.
    func handleSettledLayout(cols: Int, rows: Int, bounds: CGRect) {
        guard cols > 0, rows > 0 else { return }
        guard isManaged else {
            ptySessionLog.debug("nx-rkir6 layout-settled IGNORE(non-managed) grid=\(cols, privacy: .public)x\(rows, privacy: .public)")
            return
        }
        guard cols != lastPushedCols || rows != lastPushedRows else { return }
        guard connected else {
            // Channel not open yet — stash and apply once connect() finishes.
            pendingGrid = (cols, rows)
            ptySessionLog.debug("nx-rkir6 layout-settled DEFER(not-connected) grid=\(cols, privacy: .public)x\(rows, privacy: .public)")
            return
        }
        pushResize(cols: cols, rows: rows, reason: "layout-settled")
    }

    /// Resize tmux to the phone grid, then force a repaint. A bare resize leaves
    /// stale (wide) content on screen — tmux reflows its model but the client
    /// view isn't repainted until the next program output. We send Ctrl-L
    /// (0x0c) over the raw interact channel: most TUIs / shells redraw on it, and
    /// at a bare prompt it clears + reprompts cleanly. This is the client-side
    /// redraw the brief calls for — no agent-side `refresh-client` edit needed.
    private func pushResize(cols: Int, rows: Int, reason: String) {
        lastPushedCols = cols
        lastPushedRows = rows
        let sid = sessionId
        let origin = originAgent
        ptySessionLog.debug("nx-rkir6 requestResize(\(reason, privacy: .public)) grid=\(cols, privacy: .public)x\(rows, privacy: .public) sid=\(sid, privacy: .public)")
        nxptyLog.notice("NXPTY requestResize cols=\(cols, privacy: .public) rows=\(rows, privacy: .public) reason=\(reason, privacy: .public) sid=\(sid, privacy: .public)")
        Task { [client] in
            do {
                try await client.requestResize(sessionId: sid, cols: cols, rows: rows, originAgent: origin)
                // Client-side redraw: Ctrl-L repaints the pane at the new size so
                // stale wide content doesn't smear.
                await client.sendInteractiveInput(Data([0x0c]), originAgent: origin)
            } catch {
                ptySessionLog.error("nx-rkir6 requestResize FAILED grid=\(cols, privacy: .public)x\(rows, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
    }

    func disconnect() {
        streamTask?.cancel(); streamTask = nil
        connectWatchdog?.cancel(); connectWatchdog = nil
        connected = false
        let client = self.client
        let origin = originAgent
        Task { await client.closeInteract(originAgent: origin) }
    }

    private func feed(data: Data) async {
        connectWatchdog?.cancel(); connectWatchdog = nil
        if !sawFirstByte {
            nxptyLog.notice("NXPTY firstByte len=\(data.count, privacy: .public) sid=\(self.sessionId, privacy: .public)")
        }
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

    /// Agent-reported pane geometry (echo of our own resize). FIX B
    /// (mx-rkir.6): on iOS the PHONE owns its grid — adopting the agent's
    /// desktop-width geometry (~200 cols) is exactly what smeared the render
    /// on a ~50-col phone. We deliberately do NOT resize the local SwiftTerm
    /// grid here; SwiftTerm sizes itself from its bounds + font, and we drive
    /// tmux to the phone via `handleSettledLayout` / `sizeChanged`. After the
    /// phone-driven resize lands, the agent's geometry frame should report the
    /// phone's cols/rows anyway, so there is nothing to adopt.
    private func applyGeometry(cols: Int, rows: Int) async {
        ptySessionLog.debug("nx-rkir6 applyGeometry(NO-OP, phone owns grid) agent-reported=\(cols, privacy: .public)x\(rows, privacy: .public) phone=\(self.lastPushedCols, privacy: .public)x\(self.lastPushedRows, privacy: .public)")
        nxptyLog.notice("NXPTY geometry server cols=\(cols, privacy: .public) rows=\(rows, privacy: .public) phone=\(self.lastPushedCols, privacy: .public)x\(self.lastPushedRows, privacy: .public)")
        // Intentionally a no-op for local-grid sizing — see take-over rationale
        // above. Kept as a delegate sink so the stream's .geometry events are
        // consumed without forcing the desktop grid onto the phone.
    }

    // MARK: - Focus

    /// Tap-to-refocus (FIX A, mx-rkir.6): re-present the keyboard + accessory
    /// after a dismissal. Wired from TerminalHostView's tap recognizer.
    @objc func handleFocusTap() {
        _ = terminal?.becomeFirstResponder()
    }

    // MARK: - TerminalViewDelegate

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        // Forward raw keystroke bytes over the interact channel. No-op for
        // non-managed sessions (no tmux target). Fire-and-forget so the
        // terminal never blocks on the network.
        guard isManaged else { return }
        let payload = Data(data)
        let origin = originAgent
        nxptyLog.notice("NXPTY send bytes=\(payload.count, privacy: .public) managed=\(self.isManaged, privacy: .public) sid=\(self.sessionId, privacy: .public)")
        Task { [client] in
            await client.sendInteractiveInput(payload, originAgent: origin)
        }
    }

    /// SwiftTerm reflowed (keyboard/rotation changed the grid) — forward the
    /// new size to the agent so the tmux pane matches. Managed-gated. Routed
    /// through the same dedup+redraw path as layout-driven resizes.
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard isManaged, newCols > 0, newRows > 0 else { return }
        guard newCols != lastPushedCols || newRows != lastPushedRows else { return }
        guard connected else {
            pendingGrid = (newCols, newRows)
            return
        }
        pushResize(cols: newCols, rows: newRows, reason: "sizeChanged")
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
