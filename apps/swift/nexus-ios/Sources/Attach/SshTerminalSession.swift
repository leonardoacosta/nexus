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

    /// Keyboard-driven resize state (nx-gmes8). When the iOS keyboard shows/hides
    /// it changes our bounds, and the resulting layout passes flow through
    /// `handleSettledLayout` / `sizeChanged` exactly like rotation. But a fast
    /// dismiss/re-show (or the keyboard's own show animation) fires many such
    /// passes in a burst — we coalesce them behind a trailing debounce so tmux
    /// gets ONE `pushResize`, not one per notification/frame. Rotation and
    /// first-layout stay immediate (unchanged).
    /// Published height (points) the keyboard currently overlaps the terminal by.
    @Binding var keyboardOverlap: CGFloat
    /// Set on any keyboard show/hide notification; the next settled-layout pass is
    /// then routed through the debounce instead of pushing immediately. Cleared
    /// when the debounced push fires.
    private var keyboardResizePending = false
    private var keyboardResizeTask: Task<Void, Never>?
    private var keyboardResizeTarget: (cols: Int, rows: Int)?
    /// Trailing-debounce window. MUST outlast AttachScene's `.easeOut(duration:
    /// 0.25)` keyboard-inset frame animation so the debounce fires AFTER the frame
    /// has visually settled — a shorter window (the old 200ms) could elapse
    /// mid-animation and push a resize computed from an intermediate frame.
    private let keyboardResizeDebounceNanos: UInt64 = 320_000_000  // ~320ms trailing (> 250ms anim)

    /// Conditional scroll-lock state (conditional-scroll-non-altscreen-ios).
    /// Mirrors the LIVE `isScrollEnabled` we last applied. Starts `false` to match
    /// TerminalHostView.makeUIView's hardcoded START-LOCKED default, so the first
    /// re-evaluation (first `rangeChanged` on feed, or a keyboard event) only
    /// touches the scroll view when the combined condition actually changes.
    private var scrollCurrentlyEnabled = false

    init(statusBinding: Binding<AttachStatus>, client: NexusAggregateClient, keyboardOverlap: Binding<CGFloat>) {
        self._status = statusBinding
        self.client = client
        self._keyboardOverlap = keyboardOverlap
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

        // ios-session-navigation (UI 2.8): establish the OUTPUT stream
        // subscription FIRST, then open the interact (writer) channel. The
        // writer claim must never race an unregistered stream — opening
        // interact before consumePtyStream has registered the session's stream
        // could land the `claimWriter` call against a stream the agent hasn't
        // yet seen (the agent returns false for a `!stream` open). Subscribing
        // first guarantees the stream is registered before we claim the writer.
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

        // Open the raw-input WS channel for managed sessions so keystrokes
        // write raw bytes (no tmux send-keys Enter append). Best-effort: a
        // 4009 writer-denied close flips the channel read-only internally.
        // Opened AFTER the output stream subscription above (UI 2.8) so the
        // writer claim never races an unregistered stream.
        if isManaged {
            // mx-rkir.13: route the interact channel exactly like the proven
            // macOS PtyViewer — `originAgent: nil` so openInteract + every
            // sendInteractiveInput + closeInteract deterministically resolve to
            // the SAME NexusClient (clients.first). Passing `session.agent` here
            // risked open/send landing on different clients (or a client whose
            // session isn't the writer), so iOS bytes were written to a
            // NexusClient whose interactChannel was never opened -> dropped
            // client-side. The read-only PTY *stream* still fans out to all
            // agents via consumePtyStream, so render was unaffected.
            await client.openInteract(sessionId: session.id, originAgent: nil)
            let readOnly = await client.isInteractReadOnly(originAgent: nil)
            nxptyLog.notice("NXPTY interact opened sid=\(session.id, privacy: .public) readOnly=\(readOnly, privacy: .public)")
        } else {
            nxptyLog.notice("NXPTY interact skipped sid=\(session.id, privacy: .public) reason=non-managed")
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
        guard connected else {
            // Channel not open yet — stash and apply once connect() finishes.
            pendingGrid = (cols, rows)
            ptySessionLog.debug("nx-rkir6 layout-settled DEFER(not-connected) grid=\(cols, privacy: .public)x\(rows, privacy: .public)")
            return
        }
        // Keyboard show/hide changed our bounds → coalesce the burst of layout
        // passes into a single resize (nx-gmes8). Runs BEFORE the dedup guard so a
        // hide that reverts to the pre-keyboard grid still records the target and
        // lets the debounce settle to a no-op (cancelling the stale shrunk push).
        // Rotation/first-layout are not keyboard-driven, so they fall through to
        // the immediate push below.
        if keyboardResizePending {
            scheduleKeyboardResize(cols: cols, rows: rows, reason: "layout-settled(kbd)")
            return
        }
        guard cols != lastPushedCols || rows != lastPushedRows else { return }
        pushResize(cols: cols, rows: rows, reason: "layout-settled")
    }

    /// Trailing-debounced resize for keyboard-driven layout changes (nx-gmes8).
    /// Records the LATEST desired grid and (re)arms a ~200ms timer; only the final
    /// settled grid is pushed. A show-then-hide that returns to the original grid
    /// dedups to a no-op at fire time (guard against `lastPushed*`), so a stale
    /// intermediate grid is never left applied.
    private func scheduleKeyboardResize(cols: Int, rows: Int, reason: String) {
        keyboardResizeTarget = (cols, rows)
        keyboardResizeTask?.cancel()
        keyboardResizeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: self?.keyboardResizeDebounceNanos ?? 320_000_000)
            guard let self, !Task.isCancelled else { return }
            guard self.keyboardResizeTarget != nil else { return }
            self.keyboardResizeTarget = nil
            self.keyboardResizePending = false
            // Push the LIVE settled grid at fire time, not the grid captured when
            // the debounce was (re)armed. layoutSubviews can coalesce and stop
            // firing before SwiftUI's 250ms inset animation visually completes, so
            // the last CAPTURED grid may be an intermediate value. Because the
            // debounce window now outlasts that animation, by fire time SwiftTerm
            // has reflowed to its final bounds — its current cols/rows are the
            // authoritative settled grid. Fall back to the captured target only if
            // the view is gone.
            let settled: (cols: Int, rows: Int)? = self.terminal.map {
                let t = $0.getTerminal(); return (t.cols, t.rows)
            }
            let target = settled ?? (cols, rows)
            guard target.cols > 0, target.rows > 0 else { return }
            guard target.cols != self.lastPushedCols || target.rows != self.lastPushedRows else {
                ptySessionLog.debug("nx-gmes8 kbd-debounce settle NO-CHANGE grid=\(target.cols, privacy: .public)x\(target.rows, privacy: .public)")
                return
            }
            self.pushResize(cols: target.cols, rows: target.rows, reason: reason)
        }
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
                // stale wide content doesn't smear. originAgent: nil to hit the
                // SAME interact channel keystrokes use (mx-rkir.13).
                await client.sendInteractiveInput(Data([0x0c]), originAgent: nil)
            } catch {
                ptySessionLog.error("nx-rkir6 requestResize FAILED grid=\(cols, privacy: .public)x\(rows, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
    }

    func disconnect() {
        streamTask?.cancel(); streamTask = nil
        connectWatchdog?.cancel(); connectWatchdog = nil
        keyboardResizeTask?.cancel(); keyboardResizeTask = nil
        connected = false
        let client = self.client
        // originAgent: nil — close the same channel open()/send() used.
        Task { await client.closeInteract(originAgent: nil) }
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

    /// Resign first responder on the LIVE terminal view (keyboard-aware-terminal-
    /// resize-ios follow-up). `terminal` is `private`, so AttachScene's ungated
    /// toolbar button can't reach it directly; it routes here through the
    /// AttachTeardown bridge instead of the responder-chain `sendAction(nil)`
    /// trick, which never resigned the terminal on-device. Resigning fires
    /// keyboardWillHide -> keyboardOverlap = 0, which hides the dismiss button.
    func dismissKeyboard() {
        _ = terminal?.resignFirstResponder()
    }

    // MARK: - Keyboard-aware resize (nx-eqpvh)

    /// Keyboard about to show: publish the overlap height so AttachScene can
    /// shrink the terminal above the keyboard (nx-wwoot). Measured against the
    /// STABLE window bounds — not the view's own bounds, which are already being
    /// lifted by the overlap — so a redundant willShow can't re-measure against
    /// the lifted frame and collapse the inset (oscillation). The keyboard frame
    /// (incl. SwiftTerm's input-accessory row) is anchored to the screen bottom;
    /// for nx's single full-screen window screen coords == window coords, so the
    /// overlap on the full-bleed terminal is how far the keyboard rises above the
    /// window bottom.
    @objc func keyboardWillShow(_ note: Notification) {
        keyboardResizePending = true
        guard let view = terminal, let window = view.window,
              let info = note.userInfo,
              let endFrame = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        else {
            keyboardOverlap = 0
            // Could not measure the frame; treat as keyboard-down and re-lock per
            // alt-screen state so the scroll condition never goes stale.
            reevaluateScrollLock()
            return
        }
        let overlap = max(0, window.bounds.maxY - endFrame.minY)
        nxptyLog.notice("NXPTY keyboard show overlap=\(Int(overlap), privacy: .public)")
        keyboardOverlap = overlap
        // Keyboard rising -> scroll must re-lock (keyboard no longer down), snapping
        // back to live content. Converges on the same combined condition as
        // rangeChanged via the shared helper (conditional-scroll-non-altscreen-ios).
        reevaluateScrollLock()
    }

    /// Keyboard about to hide: overlap goes to 0 → AttachScene restores the
    /// full-bleed height, and the resulting layout pass reflows tmux back
    /// (debounced with the show, so a fast toggle nets one resize).
    @objc func keyboardWillHide(_ note: Notification) {
        keyboardResizePending = true
        nxptyLog.notice("NXPTY keyboard hide overlap=0")
        keyboardOverlap = 0
        // Keyboard down -> scroll may unlock (if the session is NOT in alt-screen).
        // Same shared helper as rangeChanged / keyboardWillShow.
        reevaluateScrollLock()
    }

    /// Re-evaluate the conditional scroll lock from the CURRENT live state — reads
    /// keyboard-down (`keyboardOverlap == 0`) and alt-screen
    /// (`isCurrentBufferAlternate`) and forwards to `applyScrollLockState`. Shared
    /// by both keyboard handlers so they converge on the same condition as the
    /// buffer-change trigger (conditional-scroll-non-altscreen-ios).
    private func reevaluateScrollLock() {
        applyScrollLockState(
            keyboardDown: keyboardOverlap == 0,
            alternateActive: terminal?.getTerminal().isCurrentBufferAlternate ?? false
        )
    }

    /// Remove the keyboard observers + cancel any in-flight debounce. Called from
    /// TerminalHostView.dismantleUIView alongside `disconnect()`.
    func teardownKeyboard() {
        NotificationCenter.default.removeObserver(self, name: UIResponder.keyboardWillShowNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIResponder.keyboardWillHideNotification, object: nil)
        keyboardResizeTask?.cancel(); keyboardResizeTask = nil
    }

    // MARK: - TerminalViewDelegate

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        // Forward raw keystroke bytes over the interact channel. No-op for
        // non-managed sessions (no tmux target). Fire-and-forget so the
        // terminal never blocks on the network.
        guard isManaged else { return }
        let payload = Data(data)
        nxptyLog.notice("NXPTY send bytes=\(payload.count, privacy: .public) managed=\(self.isManaged, privacy: .public) sid=\(self.sessionId, privacy: .public)")
        Task { [client] in
            // originAgent: nil — same client the interact channel was opened on
            // (clients.first), matching macOS. See connect() for rationale.
            await client.sendInteractiveInput(payload, originAgent: nil)
        }
    }

    /// SwiftTerm reflowed (keyboard/rotation changed the grid) — forward the
    /// new size to the agent so the tmux pane matches. Managed-gated. Routed
    /// through the same dedup+redraw path as layout-driven resizes.
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard isManaged, newCols > 0, newRows > 0 else { return }
        guard connected else {
            pendingGrid = (newCols, newRows)
            return
        }
        // Keyboard-driven reflows share the same debounce as layout-settled
        // (nx-gmes8) so a keyboard toggle issues one resize, not one per event.
        if keyboardResizePending {
            scheduleKeyboardResize(cols: newCols, rows: newRows, reason: "sizeChanged(kbd)")
            return
        }
        guard newCols != lastPushedCols || newRows != lastPushedRows else { return }
        pushResize(cols: newCols, rows: newRows, reason: "sizeChanged")
    }

    func scrolled(source: TerminalView, position: Double) {}
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String : String]) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func bell(source: TerminalView) {}

    /// SwiftTerm buffer visual change (conditional-scroll-non-altscreen-ios).
    /// Fires on every display update because `notifyUpdateChanges = true` was set
    /// in TerminalHostView.makeUIView. There is no dedicated alt-screen-swap
    /// delegate hook, so this is how we detect a plain shell entering/leaving
    /// alt-screen (`less`/`vim`, or the Claude Code TUI) reactively and re-evaluate
    /// the scroll lock. Alt-screen state is read from the source's own terminal;
    /// keyboard-down state is derived from the existing `keyboardOverlap` tracking.
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {
        applyScrollLockState(
            keyboardDown: keyboardOverlap == 0,
            alternateActive: source.getTerminal().isCurrentBufferAlternate
        )
    }

    // MARK: - Conditional scroll lock (conditional-scroll-non-altscreen-ios)

    /// Combined scroll-lock evaluation. Scroll is enabled ONLY when the keyboard is
    /// down AND the session is NOT in tmux alt-screen mode — alt-screen sessions
    /// (the Claude Code TUI, or a plain shell running `less`/`vim`) must NEVER
    /// scroll, because dragging SwiftTerm's local scrollback exposes stale buffer
    /// rows tmux is redrawing over (garble, bd:mx-rkir.11).
    ///
    /// Called from BOTH triggers so they converge on the same condition: this
    /// delegate's `rangeChanged` (buffer transitions re-checking keyboard state) and
    /// the `keyboardWillShow`/`keyboardWillHide` handlers (keyboard transitions
    /// re-checking alt-screen state). Every scroll-view property flips in LOCKSTEP
    /// with `isScrollEnabled` so an alt-screen session never shows a scroll indicator
    /// or accepts a bounce even momentarily. `contentInsetAdjustmentBehavior` stays
    /// `.never` permanently (set once in makeUIView) — it is already the locked-safe
    /// value in both states, and toggling it would fight the keyboard-aware inset
    /// resize (nx-eqpvh/nx-wwoot).
    ///
    /// On a re-lock transition (enabled -> disabled: keyboard comes up, or the
    /// session enters alt-screen) while scrolled away from the bottom, snap back to
    /// the live region so the user is never left staring at a stale scroll position.
    /// SwiftTerm pins live content by driving `contentOffset` to the bottom on each
    /// feed via its internal `updateScroller()` (which uses the module-internal
    /// `cellDimension`); the public UIScrollView-native equivalent of that same
    /// target position is `contentSize.height - bounds.height`.
    private func applyScrollLockState(keyboardDown: Bool, alternateActive: Bool) {
        guard let view = terminal else { return }
        let enable = keyboardDown && !alternateActive
        guard enable != scrollCurrentlyEnabled else { return }
        // Re-lock (enabled -> disabled): pin back to the live/bottom region.
        if scrollCurrentlyEnabled && !enable {
            let bottomY = max(0, view.contentSize.height - view.bounds.height)
            view.setContentOffset(CGPoint(x: 0, y: bottomY), animated: false)
        }
        scrollCurrentlyEnabled = enable
        view.isScrollEnabled = enable
        view.bounces = enable
        view.alwaysBounceVertical = enable
        view.alwaysBounceHorizontal = enable
        view.showsVerticalScrollIndicator = enable
        view.showsHorizontalScrollIndicator = enable
        nxptyLog.notice("NXPTY scroll-lock enable=\(enable, privacy: .public) keyboardDown=\(keyboardDown, privacy: .public) alt=\(alternateActive, privacy: .public)")
    }
}

#endif
