// PtyViewer — macOS dashboard parity for the web xterm session pane.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.11)
//       openspec/changes/session-attach-and-cwd-cap (tasks 2.2, 2.3, 2.5)
// bd:nx-gaquu, nx-0ix6e, nx-qxkvq, nx-273ve
//
// SwiftTerm-based viewer that subscribes to the agent's PTY byte stream
// (`GET /sessions/{id}/stream`) AND forwards keystrokes via
// `POST /commands/send-text` for bidirectional PTY attach. Input forwarding
// is gated on `sessionType == "managed"` — non-managed sessions render
// read-only and log a one-shot warn on the first dropped keystroke.
//
// SwiftTerm is declared as an SPM package in apps/swift/project.yml.
// We guard the import with `#if canImport(SwiftTerm)` so the file
// compiles before SPM resolution lands.

import SwiftUI
import NexusShared
import os
#if canImport(AppKit)
import AppKit
#endif
#if canImport(SwiftTerm)
import SwiftTerm
#endif

private let ptyLog = Logger(subsystem: "dev.priceless.nexus", category: "PtyViewer")

struct PtyViewer: View {
    let sessionId: String
    let sessionLabel: String?
    /// `pid <N> · <machine>` rendered in the header between the title and
    /// the close button. Optional so legacy callers / tests can omit it.
    /// Caller should pass `Session.metaLine(for:)` for parity with the
    /// SessionsRowView trailing column (bd:nx-dijep).
    let sessionMeta: String?
    /// Gates bidirectional input. When `sessionType != "managed"` the
    /// SwiftTerm delegate's send() is a no-op + one-shot os_log warn.
    /// `nil` is treated as non-managed (safe default — never forward keys
    /// to a session whose ownership we can't confirm).
    let sessionType: String?
    /// Optional close handler — when present, header renders an X button
    /// that calls back to the parent (e.g. SessionsView clearing
    /// `selectedSessionId`). Pure presentation hook; PtyViewer itself
    /// does not own dismissal.
    let onClose: (() -> Void)?

    @StateObject private var model: PtyViewerModel

    init(
        sessionId: String,
        sessionLabel: String? = nil,
        sessionMeta: String? = nil,
        sessionType: String? = nil,
        onClose: (() -> Void)? = nil
    ) {
        self.sessionId = sessionId
        self.sessionLabel = sessionLabel
        self.sessionMeta = sessionMeta
        self.sessionType = sessionType
        self.onClose = onClose
        _model = StateObject(wrappedValue: PtyViewerModel(
            sessionId: sessionId,
            sessionType: sessionType
        ))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            terminal
        }
        .task {
            await model.start()
        }
        .onDisappear {
            model.stop()
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("PTY")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            // Session label degrades through gitOwnerRepo -> projectId ->
            // cwd basename -> "—". The bare em-dash is the last-resort
            // placeholder; watcher rows now always carry cwd (sourced from
            // tmux per nx-ds6rq) so the em-dash is reserved for telemetry
            // stubs with no fingerprint at all.
            Text(headerTitle)
                .font(.caption.monospaced())
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.middle)
                .accessibilityIdentifier("pty-viewer-title")
            if let meta = sessionMeta, !meta.isEmpty {
                Text(meta)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier("pty-viewer-meta")
            }
            Spacer()
            // Take-over toggle — managed-gated. Hidden entirely for
            // non-managed sessions (no tmux pane to resize). No confirmation
            // dialog: the managed-gate + the agent's auto-restore-on-detach
            // make the action safe. Enabling forwards the current grid size;
            // disabling reverts to lock mode. Spec task 2.6.
            if model.isManaged {
                Toggle(isOn: takeOverBinding) {
                    Label("Take over", systemImage: "arrow.up.left.and.arrow.down.right")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2.monospaced())
                }
                .toggleStyle(.button)
                .controlSize(.small)
                .help("Resize the session's terminal to fill this window (auto-restores on close)")
                .accessibilityIdentifier("pty-viewer-takeover-toggle")
            }
            // Error state surfaces a retry button + warn copy. The badge
            // colour also flips red via `statusColor` so the user notices
            // without reading the status word.
            if model.status == .error {
                Text("session not found")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("pty-viewer-error")
                Button {
                    Task { await model.retry() }
                } label: {
                    Image(systemName: "arrow.clockwise.circle.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Retry PTY stream")
                .accessibilityLabel("Retry PTY stream")
                .accessibilityIdentifier("pty-viewer-retry")
            }
            statusBadge
            Text(model.status.rawValue)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Close PTY viewer")
                .accessibilityLabel("Close PTY viewer")
                .accessibilityIdentifier("pty-viewer-close")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    /// Title degradation — prefers an explicit `sessionLabel` from the caller
    /// (typically `Session.projectLabel(for:)`), falling back to the raw
    /// `sessionId`. `sessionId` is never empty so the header always renders
    /// SOMETHING (bd:nx-dijep — runtime regression where label was `nil`
    /// AND projectLabel returned bare `"—"`).
    private var headerTitle: String {
        if let label = sessionLabel, !label.isEmpty, label != "—" {
            return label
        }
        return sessionId
    }

    /// Binding for the take-over toggle. Reads `geometryMode == .takeOver`;
    /// writing routes through `model.setGeometryMode` so enable forwards the
    /// grid + disable reverts to lock (the agent auto-restores). Spec task 2.6.
    private var takeOverBinding: Binding<Bool> {
        Binding(
            get: { model.geometryMode == .takeOver },
            set: { model.setGeometryMode($0 ? .takeOver : .lock) }
        )
    }

    @ViewBuilder
    private var terminal: some View {
        #if canImport(SwiftTerm) && canImport(AppKit)
        PtyTerminalRepresentable(model: model)
            .frame(minWidth: 400, minHeight: 200)
        #else
        ContentUnavailableView(
            "SwiftTerm not linked",
            systemImage: "terminal",
            description: Text("Resolve SPM dependencies (xcodegen + Xcode) to render the PTY stream.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #endif
    }

    private var statusBadge: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 8, height: 8)
    }

    private var statusColor: SwiftUI.Color {
        switch model.status {
        case .idle:        return .gray
        case .connecting:  return .yellow
        case .streaming:   return .green
        case .disconnected: return .red
        case .error:       return .red
        }
    }
}

/// How the viewer reconciles its SwiftTerm grid with the source pane.
///
/// - `.lock` (default): the grid is pinned to the agent-reported pane
///   geometry. ANSI cursor-positioning escapes land in the right cells, so
///   Claude Code's full-screen TUI renders aligned (fixes the jumble). The
///   representable letterboxes — a larger window leaves empty space rather
///   than reflowing the grid. Fully read-only, no tmux mutation.
/// - `.takeOver` (opt-in, managed-gated): the viewer forwards its own grid
///   size to the agent (`POST /commands/resize`), which resizes the tmux
///   pane so the viewer can use the full window. The agent auto-restores the
///   pane geometry on viewer detach.
///
/// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (task 2.3)
enum PtyGeometryMode: Equatable, Sendable {
    case lock
    case takeOver
}

enum PtyStatus: String, Equatable, Sendable {
    case idle = "idle"
    case connecting = "connecting"
    case streaming = "streaming"
    case disconnected = "disconnected"
    /// Stream never produced bytes within the connect window — the session id
    /// is likely stale (agent restart, session ended, fan-out 404 on every
    /// peer). User-facing recovery is the retry button in the header.
    case error = "error"
}

@MainActor
final class PtyViewerModel: ObservableObject {
    @Published private(set) var status: PtyStatus = .idle
    /// Lock (default) vs take-over. Drives whether geometry frames resize the
    /// grid (lock) or the viewer forwards its grid to the agent (take-over).
    @Published private(set) var geometryMode: PtyGeometryMode = .lock
    /// Last agent-reported pane geometry (cols, rows). Published so the
    /// representable can re-letterbox when it changes and the header can
    /// surface the size. nil until the first geometry frame arrives.
    @Published private(set) var reportedGeometry: (cols: Int, rows: Int)? = nil
    let sessionId: String
    /// Mirror of PtyViewer.sessionType — used by the coordinator to gate
    /// input forwarding. `nil` is treated as non-managed.
    let sessionType: String?

    /// True when the session is managed — the only case where take-over (and
    /// thus `POST /commands/resize`) is permitted. The header hides the
    /// take-over toggle otherwise.
    var isManaged: Bool { sessionType == "managed" }

    /// Buffered bytes received before the terminal view has been attached.
    /// Drained on `attach(view:)`.
    private var preAttachBuffer: [UInt8] = []
    private var sseTask: Task<Void, Never>?
    /// Connect-window watchdog. If no bytes arrive within
    /// `connectTimeoutSeconds` after `start()`, we flip to `.error` so the
    /// header surfaces the retry path. The aggregate client multiplexes
    /// across every agent and silently swallows per-peer 404s (the design
    /// requirement — only the owner serves bytes), so a stale session id
    /// looks like a permanent "connecting" hang from the model's POV.
    /// Watchdog converts that hang into an actionable error state.
    private var connectWatchdog: Task<Void, Never>?
    private let connectTimeoutSeconds: UInt64 = 6
    private let client = NexusShared.NexusAggregateClient()
    /// One-shot guard so the non-managed-session warn doesn't spam the log
    /// on every keystroke.
    private var loggedNonManagedSuppression = false

    #if canImport(SwiftTerm)
    private weak var terminal: TerminalView?
    #endif

    init(sessionId: String, sessionType: String? = nil) {
        self.sessionId = sessionId
        self.sessionType = sessionType
    }

    /// Forward keystrokes from the SwiftTerm delegate to the agent's
    /// `POST /commands/send-text`. Non-UTF8 byte sequences are dropped with
    /// a one-shot warn (see `loggedNonManagedSuppression` for the managed
    /// counterpart). When `sessionType != "managed"` the call is a no-op
    /// plus one-shot warn — non-managed (raw/ad_hoc) sessions don't have a
    /// tmux target to forward into.
    func forwardInput(_ data: ArraySlice<UInt8>) {
        guard sessionType == "managed" else {
            if !loggedNonManagedSuppression {
                loggedNonManagedSuppression = true
                ptyLog.warning(
                    "PtyViewer: input forwarding disabled for non-managed session (sessionId=\(self.sessionId, privacy: .public), sessionType=\(self.sessionType ?? "nil", privacy: .public))"
                )
            }
            return
        }
        guard let text = String(bytes: data, encoding: .utf8) else {
            ptyLog.warning(
                "PtyViewer: dropped non-UTF8 input (sessionId=\(self.sessionId, privacy: .public), bytes=\(data.count, privacy: .public))"
            )
            return
        }
        let sessionId = self.sessionId
        let originAgent: String? = nil
        Task { [client] in
            do {
                try await client.sendText(
                    sessionId: sessionId,
                    text: text,
                    originAgent: originAgent
                )
            } catch {
                ptyLog.error(
                    "PtyViewer: sendText failed (sessionId=\(sessionId, privacy: .public)): \(String(describing: error), privacy: .public)"
                )
            }
        }
    }

    #if canImport(SwiftTerm)
    func attach(view: TerminalView) {
        terminal = view
        if !preAttachBuffer.isEmpty {
            view.feed(byteArray: ArraySlice(preAttachBuffer))
            preAttachBuffer.removeAll(keepingCapacity: false)
        }
    }
    #endif

    func start() async {
        sseTask?.cancel()
        connectWatchdog?.cancel()
        status = .connecting
        let sid = self.sessionId
        sseTask = Task { [weak self] in
            guard let self else { return }
            // Aggregate fans out to every agent (only the session owner
            // streams; others 404/retry harmlessly) and owns retry. The
            // status pulse is approximate under fan-out — connecting until
            // first byte, then we let the stream run.
            self.status = .connecting
            await self.client.consumePtyStream(sessionId: self.sessionId) { [weak self] event in
                switch event {
                case .bytes(let data):
                    await self?.feed(data: data)
                case .geometry(let cols, let rows):
                    await self?.applyGeometry(cols: cols, rows: rows)
                }
            }
            // Only flip to .disconnected if the watchdog hasn't already
            // moved us to .error — otherwise the user sees status flicker.
            if self.status != .error {
                self.status = .disconnected
            }
        }
        // Watchdog: if we're still in .connecting after the budget elapses,
        // assume the session id is stale (agent restart / session ended)
        // and surface the error state with a retry button. os_log mirrors
        // the chat-side surfacing so production logs catch the same signal.
        connectWatchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: (self?.connectTimeoutSeconds ?? 6) * 1_000_000_000)
            guard let self else { return }
            if Task.isCancelled { return }
            if self.status == .connecting {
                ptyLog.warning(
                    "PtyViewer: stream connect timeout — likely stale session id (sessionId=\(sid, privacy: .public), windowSeconds=\(self.connectTimeoutSeconds, privacy: .public))"
                )
                self.status = .error
            }
        }
    }

    /// User-initiated retry from the header retry button. Tears down the
    /// existing stream task + watchdog and re-runs `start()`. The aggregate
    /// client owns its own per-agent backoff; this just resets the local
    /// connect window so the user gets a fresh `.error` decision after
    /// another `connectTimeoutSeconds`.
    func retry() async {
        ptyLog.info(
            "PtyViewer: user retry (sessionId=\(self.sessionId, privacy: .public))"
        )
        await start()
    }

    func stop() {
        sseTask?.cancel()
        sseTask = nil
        connectWatchdog?.cancel()
        connectWatchdog = nil
        // Revert to lock on teardown so a re-open starts clean and the agent's
        // auto-restore (fired on viewer detach) leaves the next viewer with the
        // correct pane geometry. No client-side resize needed — the agent owns
        // restore.
        geometryMode = .lock
        status = .idle
    }

    /// Apply an agent-reported pane geometry. Stores it for the representable's
    /// letterbox math and — in lock mode — pins the SwiftTerm grid to the
    /// reported cols x rows so ANSI cursor escapes land in the right cells
    /// (fixes the jumble). In take-over mode the viewer owns the grid, so a
    /// geometry frame only updates `reportedGeometry` (it's the echo of our own
    /// resize) without forcing a grid resize.
    ///
    /// MUST run on the main thread (it mutates SwiftTerm's emulator) — the
    /// model is `@MainActor`, so callers hop here automatically.
    ///
    /// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (task 2.3)
    func applyGeometry(cols: Int, rows: Int) async {
        guard cols > 0, rows > 0 else { return }
        reportedGeometry = (cols: cols, rows: rows)
        guard geometryMode == .lock else { return }
        #if canImport(SwiftTerm)
        // Resize the emulator grid to the source pane. getTerminal().resize is
        // idempotent (no-op when unchanged) so repeated identical frames are
        // cheap. The representable re-letterboxes via updateNSView when the
        // published reportedGeometry changes.
        terminal?.getTerminal().resize(cols: cols, rows: rows)
        ptyLog.debug(
            "PtyViewer: locked grid to \(cols, privacy: .public)x\(rows, privacy: .public) (sessionId=\(self.sessionId, privacy: .public))"
        )
        #endif
    }

    /// Forward the viewer's current grid to the agent (take-over). Only fired
    /// by the coordinator's `sizeChanged` when in `.takeOver` mode, and by the
    /// header toggle on enable. Server-side managed-gate is authoritative; a
    /// non-2xx (e.g. 409 non-managed) is logged. Best-effort fire-and-forget.
    ///
    /// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (tasks 2.5, 2.6)
    func requestResize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        let sid = self.sessionId
        Task { [client] in
            do {
                try await client.requestResize(
                    sessionId: sid,
                    cols: cols,
                    rows: rows,
                    originAgent: nil
                )
            } catch {
                ptyLog.error(
                    "PtyViewer: requestResize failed (sessionId=\(sid, privacy: .public), \(cols, privacy: .public)x\(rows, privacy: .public)): \(String(describing: error), privacy: .public)"
                )
            }
        }
    }

    /// Header toggle handler. Enabling take-over forwards the current grid size
    /// to the agent; disabling reverts to lock (the agent auto-restores the
    /// pane geometry on the next geometry frame / detach). Hard no-op for
    /// non-managed sessions — the toggle is hidden there, but this guards the
    /// programmatic path too. No confirmation dialog (managed-gate +
    /// auto-restore make it safe).
    ///
    /// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (task 2.6)
    func setGeometryMode(_ mode: PtyGeometryMode) {
        guard isManaged || mode == .lock else { return }
        geometryMode = mode
        #if canImport(SwiftTerm)
        if mode == .takeOver, let term = terminal?.getTerminal() {
            // Forward the grid SwiftTerm currently renders at so the agent
            // resizes the pane to fill the window.
            requestResize(cols: term.cols, rows: term.rows)
        } else if mode == .lock, let geo = reportedGeometry {
            // Snap the grid back to the last reported geometry immediately so
            // the viewer doesn't show a stale take-over grid while waiting for
            // the agent's restore geometry frame.
            terminal?.getTerminal().resize(cols: geo.cols, rows: geo.rows)
        }
        #endif
    }

    private func feed(data: Data) async {
        // First byte = stream is live. Cancel the connect-window watchdog
        // so it can't promote a momentarily-empty stream to .error.
        connectWatchdog?.cancel()
        connectWatchdog = nil
        status = .streaming
        let bytes = [UInt8](data)
        #if canImport(SwiftTerm)
        if let terminal {
            terminal.feed(byteArray: ArraySlice(bytes))
        } else {
            preAttachBuffer.append(contentsOf: bytes)
            // Cap the pre-attach buffer so a high-volume stream doesn't OOM
            // while waiting for the view to mount.
            if preAttachBuffer.count > 1_000_000 {
                preAttachBuffer.removeFirst(preAttachBuffer.count - 1_000_000)
            }
        }
        #else
        _ = bytes  // SwiftTerm unavailable — bytes are dropped.
        #endif
    }
}

#if canImport(SwiftTerm) && canImport(AppKit)

struct PtyTerminalRepresentable: NSViewRepresentable {
    @ObservedObject var model: PtyViewerModel

    /// We return a `PtyLetterboxContainer` (NOT the bare `TerminalView`) so
    /// lock mode can pin the emulator to its exact grid size and center it,
    /// leaving empty space (letterbox) when the window is larger than the
    /// reported pane. A bare `TerminalView` would auto-resize its grid to fill
    /// the SwiftUI frame (`MacTerminalView.setFrameSize` -> `processSizeChange`
    /// reflows cols/rows), which is exactly the reflow that produces the
    /// jumble. The container intercepts layout to defeat that in lock mode.
    ///
    /// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (task 2.4)
    func makeNSView(context: Context) -> PtyLetterboxContainer {
        let terminalView = TerminalView()
        context.coordinator.model = model
        terminalView.terminalDelegate = context.coordinator
        let container = PtyLetterboxContainer(terminalView: terminalView)
        Task { @MainActor in
            model.attach(view: terminalView)
        }
        return container
    }

    func updateNSView(_ nsView: PtyLetterboxContainer, context: Context) {
        context.coordinator.model = model
        // Push the current mode + reported geometry into the container so it
        // re-letterboxes when either changes (SwiftUI re-invokes updateNSView
        // on @Published mutations of the observed model).
        nsView.geometryMode = model.geometryMode
        nsView.reportedGeometry = model.reportedGeometry
        nsView.needsLayout = true
    }

    func makeCoordinator() -> PtyTerminalCoordinator {
        PtyTerminalCoordinator()
    }
}

/// Hosts the SwiftTerm `TerminalView` and lays it out per geometry mode.
///
/// - `.lock`: the terminal is sized to its **optimal grid size**
///   (`getOptimalFrameSize()` — exact cols x rows at the current font) and
///   centered. When the container is larger, the surrounding area is left
///   empty (letterbox). When smaller, the terminal is clamped to the container
///   so it never overflows. The grid itself is owned by the model
///   (`applyGeometry` -> `Terminal.resize`); this view only positions the
///   already-sized emulator, so SwiftTerm's frame-driven reflow can't fire.
/// - `.takeOver`: the terminal fills the container (classic autoresize),
///   letting the user drive the grid — `sizeChanged` forwards the new dims to
///   the agent.
///
/// Layout runs on the main thread (AppKit `layout()`), satisfying the
/// "SwiftTerm grid resize + NSView letterbox must happen on the main thread"
/// constraint.
final class PtyLetterboxContainer: NSView {
    private let terminalView: TerminalView
    var geometryMode: PtyGeometryMode = .lock
    var reportedGeometry: (cols: Int, rows: Int)? = nil

    init(terminalView: TerminalView) {
        self.terminalView = terminalView
        super.init(frame: .zero)
        wantsLayer = true
        // Match the terminal's background so the letterbox margins blend in
        // rather than showing a bright rectangle around the pane.
        layer?.backgroundColor = terminalView.nativeBackgroundColor.cgColor
        // We position the child manually in layout(); disable autoresizing so
        // AppKit doesn't fight us.
        terminalView.translatesAutoresizingMaskIntoConstraints = true
        terminalView.autoresizingMask = []
        addSubview(terminalView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    override func layout() {
        super.layout()
        let bounds = self.bounds
        switch geometryMode {
        case .takeOver:
            // Fill — the user owns the grid; SwiftTerm reflows to the frame and
            // the coordinator forwards the new size to the agent.
            terminalView.frame = bounds
        case .lock:
            // Size to the emulator's optimal grid rect, then center + clamp.
            // getOptimalFrameSize() reflects the grid the model locked via
            // Terminal.resize, so the terminal renders at 1:1 with the pane.
            let optimal = terminalView.getOptimalFrameSize().size
            let w = min(optimal.width, bounds.width)
            let h = min(optimal.height, bounds.height)
            let x = (bounds.width - w) / 2.0
            let y = (bounds.height - h) / 2.0
            terminalView.frame = NSRect(x: x, y: y, width: w, height: h)
        }
    }
}

final class PtyTerminalCoordinator: NSObject, @preconcurrency TerminalViewDelegate {
    /// Set by the representable so the synchronous SwiftTerm `send` callback
    /// can fire-and-forget a sendText call. Weak-ish (the coordinator
    /// outlives the view); the model is owned by the SwiftUI struct.
    weak var model: PtyViewerModel?

    @MainActor
    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        // SwiftTerm calls send() synchronously; the model wraps the async
        // sendText in a Task so the terminal never blocks waiting on HTTP.
        model?.forwardInput(data)
    }

    func scrolled(source: TerminalView, position: Double) {}
    func setTerminalTitle(source: TerminalView, title: String) {}

    /// SwiftTerm reports a grid change (the user resized the window so the
    /// emulator reflowed). Forward to the agent ONLY in take-over mode — in
    /// lock mode the grid is pinned to the source pane and the container
    /// letterboxes, so any sizeChanged there is incidental and must NOT mutate
    /// the tmux pane.
    ///
    /// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (task 2.5)
    @MainActor
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard model?.geometryMode == .takeOver else { return }
        model?.requestResize(cols: newCols, rows: newRows)
    }
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String : String]) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func bell(source: TerminalView) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#endif
