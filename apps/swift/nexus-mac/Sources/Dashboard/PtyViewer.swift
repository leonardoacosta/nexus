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
    let sessionId: String
    /// Mirror of PtyViewer.sessionType — used by the coordinator to gate
    /// input forwarding. `nil` is treated as non-managed.
    let sessionType: String?

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
            await self.client.consumePtyStream(sessionId: self.sessionId) { [weak self] data in
                await self?.feed(data: data)
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
        status = .idle
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

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView()
        context.coordinator.model = model
        view.terminalDelegate = context.coordinator
        Task { @MainActor in
            model.attach(view: view)
        }
        return view
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {
        context.coordinator.model = model
    }

    func makeCoordinator() -> PtyTerminalCoordinator {
        PtyTerminalCoordinator()
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
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String : String]) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func bell(source: TerminalView) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#endif
