// PtyViewer — macOS dashboard parity for the web xterm session pane.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.11)
// bd:nx-gaquu
//
// SwiftTerm-based viewer that subscribes to the agent's PTY byte stream
// (`GET /sessions/{id}/stream`) and renders the ANSI output read-only.
// Input is captured by SwiftTerm but discarded — the dashboard surface
// does not allow typing back (use the Attach button for full PTY).
//
// SwiftTerm is declared as an SPM package in apps/swift/project.yml.
// We guard the import with `#if canImport(SwiftTerm)` so the file
// compiles before SPM resolution lands.

import SwiftUI
import NexusShared
#if canImport(AppKit)
import AppKit
#endif
#if canImport(SwiftTerm)
import SwiftTerm
#endif

struct PtyViewer: View {
    let sessionId: String
    let sessionLabel: String?

    @StateObject private var model: PtyViewerModel

    init(sessionId: String, sessionLabel: String? = nil) {
        self.sessionId = sessionId
        self.sessionLabel = sessionLabel
        _model = StateObject(wrappedValue: PtyViewerModel(sessionId: sessionId))
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
        HStack {
            Text("PTY")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Text(sessionLabel ?? sessionId)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            statusBadge
            Text(model.status.rawValue)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
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

    private var statusColor: Color {
        switch model.status {
        case .idle:        return .secondary
        case .connecting:  return .yellow
        case .streaming:   return .green
        case .disconnected: return .red
        }
    }
}

enum PtyStatus: String, Equatable, Sendable {
    case idle = "idle"
    case connecting = "connecting"
    case streaming = "streaming"
    case disconnected = "disconnected"
}

@MainActor
final class PtyViewerModel: ObservableObject {
    @Published private(set) var status: PtyStatus = .idle
    let sessionId: String

    /// Buffered bytes received before the terminal view has been attached.
    /// Drained on `attach(view:)`.
    private var preAttachBuffer: [UInt8] = []
    private var sseTask: Task<Void, Never>?
    private let client: NexusShared.NexusClient = NexusShared.NexusClient()

    #if canImport(SwiftTerm)
    private weak var terminal: TerminalView?
    #endif

    init(sessionId: String) {
        self.sessionId = sessionId
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
        status = .connecting
        sseTask = Task { [weak self] in
            guard let self else { return }
            var backoff: UInt64 = 1_000_000_000
            while !Task.isCancelled {
                do {
                    try await self.client.consumePtyStream(sessionId: self.sessionId) { [weak self] data in
                        await self?.feed(data: data)
                    }
                    backoff = 1_000_000_000
                    self.status = .disconnected
                } catch {
                    if Task.isCancelled { return }
                    self.status = .disconnected
                    try? await Task.sleep(nanoseconds: backoff)
                    backoff = min(30_000_000_000, backoff * 2)
                    self.status = .connecting
                }
            }
        }
    }

    func stop() {
        sseTask?.cancel()
        sseTask = nil
        status = .idle
    }

    private func feed(data: Data) async {
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
        view.terminalDelegate = context.coordinator
        Task { @MainActor in
            model.attach(view: view)
        }
        return view
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {}

    func makeCoordinator() -> PtyTerminalCoordinator {
        PtyTerminalCoordinator()
    }
}

final class PtyTerminalCoordinator: NSObject, TerminalViewDelegate {
    // Read-only viewer — input bytes are intentionally discarded.
    func send(source: TerminalView, data: ArraySlice<UInt8>) {}
    func scrolled(source: TerminalView, position: Double) {}
    func setTerminalTitle(source: TerminalView, title: String) {}
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String : String]) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func bell(source: TerminalView) {}
}

#endif
