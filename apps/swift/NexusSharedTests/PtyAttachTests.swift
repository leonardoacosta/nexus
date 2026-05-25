// PtyAttachTests — pin the bidirectional PTY attach contract.
//
// Spec: openspec/changes/session-attach-and-cwd-cap (task 3.1)
//
// Three behavioral contracts under test:
//
//   1. testSendTextCallsClient
//      Typing into a managed session forwards to the sendText sink
//      with the correct sessionId + text payload.
//
//   2. testNonManagedSessionSuppressesInput
//      When sessionType != "managed" (e.g. "raw" or ad_hoc) the
//      forwarder MUST NOT call the sink — non-managed sessions don't
//      have a tmux pane to receive keystrokes.
//
//   3. testSendTextEncodesControlChars
//      Control-byte sequences (Ctrl-C = \x03) propagate through the
//      gate verbatim — the agent receives the raw byte for tmux to
//      interpret as SIGINT. We also confirm the JSON serialization
//      path used by NexusClient.sendText preserves the byte.
//
// Test design notes:
//   - The gate logic in PtyViewerModel.forwardInput() lives in the
//     nexus-mac target, which NexusSharedTests does NOT link. We
//     mirror the gate as a tiny `PtyInputForwarder` helper inside
//     this file. The helper is the unit under test; if PtyViewer's
//     gate regresses (e.g. someone drops the sessionType check), the
//     gate's CONTRACT (managed → forward, non-managed → drop) is
//     still pinned here so PtyViewer can be refactored against a
//     stable spec.
//   - The sink is injected as an `@Sendable` closure so we capture
//     invocations directly without standing up an HTTP stub. This
//     keeps the test hermetic (no localhost:7400 fallthrough) and
//     mirrors the way `NexusClient.sendText` is wired into
//     `PtyViewerModel` in production — via a single function call
//     with `(sessionId, text)`.
//
// Pattern reference: PayloadDecodeTests.swift (inline fixtures,
// XCTest discipline).

import XCTest
@testable import NexusShared

final class PtyAttachTests: XCTestCase {

    // MARK: - Test 1: managed session forwards to sendText with correct args

    func testSendTextCallsClient() async throws {
        let recorder = SendRecorder()
        let forwarder = PtyInputForwarder(
            sessionId: "sess-managed-001",
            sessionType: "managed",
            send: { sid, text in
                await recorder.record(sessionId: sid, text: text)
            }
        )

        await forwarder.forwardInput(bytes: Array("ls\n".utf8))

        let calls = await recorder.calls
        XCTAssertEqual(calls.count, 1,
                       "managed session should issue exactly one sendText per keystroke batch")
        XCTAssertEqual(calls[0].sessionId, "sess-managed-001")
        XCTAssertEqual(calls[0].text, "ls\n")
    }

    // MARK: - Test 2: non-managed session drops input (no sink call)

    func testNonManagedSessionSuppressesInput() async throws {
        let recorder = SendRecorder()

        // sessionType="raw" — explicitly non-managed.
        let rawForwarder = PtyInputForwarder(
            sessionId: "sess-raw-002",
            sessionType: "raw",
            send: { sid, text in
                await recorder.record(sessionId: sid, text: text)
            }
        )
        await rawForwarder.forwardInput(bytes: Array("ls\n".utf8))

        // sessionType=nil — production also treats nil as non-managed
        // (PtyViewerModel.forwardInput "nil is treated as non-managed —
        // safe default").
        let nilForwarder = PtyInputForwarder(
            sessionId: "sess-nil-003",
            sessionType: nil,
            send: { sid, text in
                await recorder.record(sessionId: sid, text: text)
            }
        )
        await nilForwarder.forwardInput(bytes: Array("ls\n".utf8))

        // sessionType="ad_hoc" — another non-managed flavor.
        let adHocForwarder = PtyInputForwarder(
            sessionId: "sess-adhoc-004",
            sessionType: "ad_hoc",
            send: { sid, text in
                await recorder.record(sessionId: sid, text: text)
            }
        )
        await adHocForwarder.forwardInput(bytes: Array("ls\n".utf8))

        let calls = await recorder.calls
        XCTAssertEqual(calls.count, 0,
                       "raw / nil / ad_hoc sessionType should all drop the keystrokes — only \"managed\" forwards")
    }

    // MARK: - Test 3: control bytes (Ctrl-C = \x03) survive the gate

    func testSendTextEncodesControlChars() async throws {
        let recorder = SendRecorder()
        let forwarder = PtyInputForwarder(
            sessionId: "sess-ctrl-005",
            sessionType: "managed",
            send: { sid, text in
                await recorder.record(sessionId: sid, text: text)
            }
        )

        // Ctrl-C = ETX = 0x03. The gate must NOT drop or transform the
        // byte — tmux interprets the raw byte as SIGINT.
        await forwarder.forwardInput(bytes: [0x03])

        let calls = await recorder.calls
        XCTAssertEqual(calls.count, 1,
                       "managed session should accept a single-byte control sequence")
        XCTAssertEqual(calls[0].sessionId, "sess-ctrl-005")
        let bytes = Array(calls[0].text.utf8)
        XCTAssertEqual(bytes, [0x03],
                       "Ctrl-C (0x03) must reach the sink verbatim")

        // Belt-and-braces: prove the JSON encoding NexusClient.sendText
        // uses (JSONSerialization with [sessionId, text]) preserves the
        // control byte end-to-end. If a future refactor switches to a
        // codec that strips control chars, this assertion catches it.
        let body: [String: String] = [
            "sessionId": calls[0].sessionId,
            "text": calls[0].text
        ]
        let data = try JSONSerialization.data(withJSONObject: body)
        let roundTripped = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: String]
        )
        let roundTrippedBytes = Array((roundTripped["text"] ?? "").utf8)
        XCTAssertEqual(roundTrippedBytes, [0x03],
                       "Ctrl-C must survive the JSON serialization NexusClient.sendText uses")
    }

    // MARK: - Task 3.4: geometry lock + take-over resize gating
    //
    // The grid-lock + take-over logic lives in PtyViewerModel (nexus-mac,
    // which NexusSharedTests does NOT link). We mirror the two contracts as a
    // tiny `PtyGeometryReconciler` helper — identical decision logic to
    // PtyViewer.swift's `applyGeometry` / `sizeChanged` gate — so the spec
    // assertions stay pinned even as PtyViewer is refactored. Same discipline
    // as PtyInputForwarder above.

    /// A geometry control frame in lock mode resizes the grid to the reported
    /// cols x rows. (Production: `PtyViewerModel.applyGeometry` -> SwiftTerm
    /// `Terminal.resize`.)
    func testGeometryFrameLocksGridInLockMode() async throws {
        let recon = PtyGeometryReconciler(mode: .lock)
        recon.applyGeometry(cols: 120, rows: 40)
        XCTAssertEqual(recon.grid?.cols, 120,
                       "lock mode must pin the grid columns to the reported pane width")
        XCTAssertEqual(recon.grid?.rows, 40,
                       "lock mode must pin the grid rows to the reported pane height")
        XCTAssertEqual(recon.resizeCalls.count, 0,
                       "a geometry frame in lock mode must NOT forward a resize to the agent")
    }

    /// In lock mode, a SwiftTerm `sizeChanged` must NOT forward a resize — the
    /// grid is pinned to the source pane and the view letterboxes.
    func testSizeChangedDoesNotResizeInLockMode() async throws {
        let recon = PtyGeometryReconciler(mode: .lock)
        recon.sizeChanged(newCols: 200, newRows: 60)
        XCTAssertEqual(recon.resizeCalls.count, 0,
                       "sizeChanged in lock mode must not POST /commands/resize")
    }

    /// In take-over mode, a SwiftTerm `sizeChanged` forwards the new grid to
    /// the agent so the tmux pane resizes to fill the window.
    func testSizeChangedForwardsResizeInTakeOverMode() async throws {
        let recon = PtyGeometryReconciler(mode: .takeOver)
        recon.sizeChanged(newCols: 200, newRows: 60)
        XCTAssertEqual(recon.resizeCalls.count, 1,
                       "take-over mode must forward exactly one resize per sizeChanged")
        XCTAssertEqual(recon.resizeCalls[0].cols, 200)
        XCTAssertEqual(recon.resizeCalls[0].rows, 60)
    }

    /// The agent's geometry control frame parses into a
    /// `PtyStreamEvent.geometry`. Pins the wire contract
    /// (`{"type":"geometry","cols":N,"rows":N}`) the agent ships.
    func testGeometryControlFrameShape() throws {
        let json = #"{"type":"geometry","cols":120,"rows":40}"#
        let obj = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: Data(json.utf8)
            ) as? [String: Any]
        )
        XCTAssertEqual(obj["type"] as? String, "geometry")
        XCTAssertEqual((obj["cols"] as? NSNumber)?.intValue, 120)
        XCTAssertEqual((obj["rows"] as? NSNumber)?.intValue, 40)
    }

    // MARK: - Task 3.x: raw interactive input over /interact WS
    //
    // pty-raw-interactive-input (nx-bv9oz). The production rewire routes
    // keystrokes through `NexusAggregateClient.sendInteractiveInput` (raw bytes,
    // BINARY WS frame, NO appended Enter) instead of `sendText`. The gate +
    // routing decision logic lives in PtyViewerModel (nexus-mac, NOT linked by
    // NexusSharedTests), so — same discipline as PtyInputForwarder above — we
    // mirror the forwarder against an injected fake interact transport and pin
    // the four behavioral contracts:
    //
    //   1. a managed keystroke writes RAW bytes with NO appended Enter and does
    //      NOT call the sendText sink (the auto-Enter regression class).
    //   2. the Return key (0x0D) is forwarded verbatim as a carriage return.
    //   3. a non-managed session opens NO interact channel (and forwards nothing).
    //   4. a 4009 writer-denied close degrades to read-only: subsequent sends
    //      are no-ops and nothing crashes.

    /// 1. A forwarded keystroke writes raw bytes over the interact transport
    ///    with NO appended Enter, and never touches the sendText sink.
    func testInteractForwardWritesRawBytesNoEnter() async throws {
        let transport = FakeInteractTransport()
        let sendTextSink = SendRecorder()
        let forwarder = RawInputForwarder(
            sessionType: "managed",
            interact: transport,
            sendText: { sid, text in
                await sendTextSink.record(sessionId: sid, text: text)
            }
        )

        await forwarder.forwardInput(bytes: Array("a".utf8))

        let frames = await transport.frames
        XCTAssertEqual(frames.count, 1, "managed keystroke must write exactly one interact frame")
        XCTAssertEqual(Array(frames[0]), [0x61], "the byte 'a' must be written verbatim")
        XCTAssertFalse(
            Array(frames[0]).contains(0x0A) || Array(frames[0]).contains(0x0D),
            "no LF (0x0A) or CR (0x0D) Enter may be appended to a plain keystroke"
        )
        let sendTextCalls = await sendTextSink.calls
        XCTAssertEqual(sendTextCalls.count, 0, "interact path must NOT call sendText (no tmux send-keys)")
    }

    /// 2. The Return key arrives from SwiftTerm as a carriage return (0x0D) and
    ///    is forwarded verbatim — Enter is an explicit keypress, not an append.
    func testInteractForwardSendsCarriageReturnForReturnKey() async throws {
        let transport = FakeInteractTransport()
        let forwarder = RawInputForwarder(
            sessionType: "managed",
            interact: transport,
            sendText: { _, _ in }
        )

        // SwiftTerm emits 0x0D for the Return key.
        await forwarder.forwardInput(bytes: [0x0D])

        let frames = await transport.frames
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(Array(frames[0]), [0x0D], "Return must reach the PTY as a single CR (0x0D)")
    }

    /// 3. A non-managed session never opens an interact channel and forwards no
    ///    bytes (and still doesn't fall back to sendText).
    func testNonManagedOpensNoInteractChannel() async throws {
        let transport = FakeInteractTransport()
        let sendTextSink = SendRecorder()

        for nonManaged in ["raw", "ad_hoc", nil] as [String?] {
            let forwarder = RawInputForwarder(
                sessionType: nonManaged,
                interact: transport,
                sendText: { sid, text in
                    await sendTextSink.record(sessionId: sid, text: text)
                }
            )
            await forwarder.maybeOpen()
            await forwarder.forwardInput(bytes: Array("ls".utf8))
        }

        let opened = await transport.openCount
        XCTAssertEqual(opened, 0, "non-managed sessions must NOT open an interact channel")
        let frames = await transport.frames
        XCTAssertEqual(frames.count, 0, "non-managed keystrokes must be dropped")
        let sendTextCalls = await sendTextSink.calls
        XCTAssertEqual(sendTextCalls.count, 0, "non-managed must not fall back to sendText either")
    }

    /// 4. A 4009 writer-denied close degrades the channel to read-only:
    ///    subsequent sends are no-ops and nothing crashes.
    func testInteract4009DeniedDegradesToReadOnly() async throws {
        let transport = FakeInteractTransport()
        let forwarder = RawInputForwarder(
            sessionType: "managed",
            interact: transport,
            sendText: { _, _ in }
        )

        await forwarder.maybeOpen()
        // Agent claims writer-denied → application close 4009. The channel
        // flips read-only (mirrors PtyInteractChannel.markReadOnly()).
        await transport.simulateDeniedClose(code: 4009)

        // Subsequent sends must be no-ops — no frames, no crash.
        await forwarder.forwardInput(bytes: Array("a".utf8))
        await forwarder.forwardInput(bytes: [0x0D])

        let frames = await transport.frames
        XCTAssertEqual(frames.count, 0, "read-only channel must drop all keystrokes")
        let readOnly = await transport.isReadOnly
        XCTAssertTrue(readOnly, "a 4009 denied-close must leave the channel read-only")
    }
}

// MARK: - Test helpers

/// Captured invocation of the sendText sink. Comparable so call lists
/// can be asserted by value.
private struct SendCall: Sendable, Equatable {
    let sessionId: String
    let text: String
}

/// Actor-isolated recorder so a closure shared across multiple
/// forwarders can append concurrently without a data race.
private actor SendRecorder {
    private(set) var calls: [SendCall] = []

    func record(sessionId: String, text: String) {
        calls.append(SendCall(sessionId: sessionId, text: text))
    }
}

/// Mirror of `PtyViewerModel.forwardInput()` lifted out of nexus-mac so
/// the gate contract is unit-testable from NexusSharedTests (which only
/// links NexusShared, not the macOS app). The gate logic is intentionally
/// identical to `apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`
/// — any drift between PtyViewer's gate and this helper means the test
/// no longer reflects production. Keep them in lockstep.
private final class PtyInputForwarder {
    let sessionId: String
    let sessionType: String?
    /// Injected sink — production routes this to
    /// `NexusAggregateClient.sendText` (which forwards to
    /// `NexusClient.sendText`). The closure is `@Sendable` so tests
    /// can use actor-isolated recorders.
    private let send: @Sendable (String, String) async -> Void

    init(
        sessionId: String,
        sessionType: String?,
        send: @escaping @Sendable (String, String) async -> Void
    ) {
        self.sessionId = sessionId
        self.sessionType = sessionType
        self.send = send
    }

    func forwardInput(bytes: [UInt8]) async {
        // Gate: only managed sessions get keystrokes forwarded.
        // Production: PtyViewer.swift:176 — `guard sessionType == "managed"`.
        guard sessionType == "managed" else { return }
        // Production drops non-UTF8 byte slices with a one-shot warn.
        // PtyViewer.swift:185 — `String(bytes: data, encoding: .utf8)`.
        guard let text = String(bytes: bytes, encoding: .utf8) else { return }
        await send(sessionId, text)
    }
}

/// Mirror of PtyViewerModel's geometry reconciliation (lock vs take-over)
/// lifted out of nexus-mac so the lock/forward CONTRACT is unit-testable from
/// NexusSharedTests. Decision logic is intentionally identical to
/// `PtyViewer.swift` (`applyGeometry` pins the grid in lock mode;
/// `sizeChanged`/`requestResize` forward only in take-over). Keep in lockstep.
private final class PtyGeometryReconciler {
    enum Mode { case lock, takeOver }

    struct GridSize: Equatable { let cols: Int; let rows: Int }

    private(set) var mode: Mode
    private(set) var grid: GridSize?
    private(set) var resizeCalls: [GridSize] = []

    init(mode: Mode) { self.mode = mode }

    /// Production: PtyViewerModel.applyGeometry — store the reported geometry;
    /// in lock mode pin the grid to it; never forwards a resize.
    func applyGeometry(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        if mode == .lock {
            grid = GridSize(cols: cols, rows: rows)
        }
    }

    /// Production: PtyTerminalCoordinator.sizeChanged — forward to the agent
    /// ONLY in take-over mode.
    func sizeChanged(newCols: Int, newRows: Int) {
        guard mode == .takeOver else { return }
        resizeCalls.append(GridSize(cols: newCols, rows: newRows))
    }
}

// MARK: - Raw interactive input test helpers (pty-raw-interactive-input)

/// Injected fake for the `/interact` WS transport. Mirrors the observable
/// surface of `PtyInteractChannel` (open / send raw binary frame / read-only
/// after a 4009 denied-close) so `RawInputForwarder` can be exercised without a
/// live NWConnection. Actor-isolated so concurrent forwarders are race-free.
private actor FakeInteractTransport {
    private(set) var frames: [Data] = []
    private(set) var openCount = 0
    private(set) var isReadOnly = false

    func open() { openCount += 1 }

    /// Production `PtyInteractChannel.send` — no-op once read-only, else records
    /// the raw binary frame verbatim.
    func send(_ bytes: Data) {
        if isReadOnly { return }
        frames.append(bytes)
    }

    /// Production `PtyInteractChannel.markReadOnly` triggered by an agent
    /// application close. The agent uses 4009 for writer-denied.
    func simulateDeniedClose(code: Int) {
        isReadOnly = true
    }
}

/// Mirror of `PtyViewerModel`'s interact-channel forwarding lifted out of
/// nexus-mac so the raw-input CONTRACT is unit-testable from NexusSharedTests.
/// Decision logic is intentionally identical to `PtyViewer.swift` after the
/// pty-raw-interactive-input rewire:
///   - managed-gate: only `sessionType == "managed"` opens/forwards.
///   - `maybeOpen()` mirrors `PtyViewerModel.start()`'s `if isManaged { openInteract }`.
///   - `forwardInput` writes RAW bytes (no UTF-8 round-trip, no Enter append)
///     via the interact transport — never `sendText`.
/// Keep in lockstep with PtyViewer.swift.
private final class RawInputForwarder {
    let sessionType: String?
    private let interact: FakeInteractTransport
    /// Present only to PROVE the rewire never falls back to it. Production keeps
    /// `sendText` for STT command injection, but the keystroke path must not use it.
    private let sendText: @Sendable (String, String) async -> Void

    init(
        sessionType: String?,
        interact: FakeInteractTransport,
        sendText: @escaping @Sendable (String, String) async -> Void
    ) {
        self.sessionType = sessionType
        self.interact = interact
        self.sendText = sendText
    }

    var isManaged: Bool { sessionType == "managed" }

    /// Mirror of `PtyViewerModel.start()` — open the interact channel only for
    /// managed sessions.
    func maybeOpen() async {
        guard isManaged else { return }
        await interact.open()
    }

    /// Mirror of `PtyViewerModel.forwardInput` (post-rewire): managed-gate, then
    /// write RAW bytes over the interact transport. No Enter, no sendText.
    func forwardInput(bytes: [UInt8]) async {
        guard isManaged else { return }
        await interact.send(Data(bytes))
    }
}
