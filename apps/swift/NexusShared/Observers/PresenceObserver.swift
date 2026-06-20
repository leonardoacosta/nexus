// PresenceObserver — the reusable, headless Mac presence sensor.
//
// Spec: openspec/changes/mac-presence-observer (capability context-aware-routing)
//
// Why this exists
// ───────────────
// Phase 1 shipped the presence *spine* (vector + rules engine + held queue)
// but nothing senses the local Mac. PresenceObserver is the sibling of
// NowPlayingController / SessionObserver in NexusShared/Observers: it owns the
// live system listeners and turns raw macOS signals into a PresenceDelta the
// `nexus-presence` LaunchAgent POSTs to the local agent's `/presence/report`.
//
// Signals sensed (all macOS, all permission-light):
//   • HID idle           — CGEventSource.secondsSinceLastEventType (active gate)
//   • screen lock        — com.apple.screenIsLocked / …UnlockedTemporarily via
//                          DistributedNotificationCenter + CGSession console
//   • camera in-use      — CMIO kCMIODevicePropertyDeviceIsRunningSomewhere
//   • mic in-use         — CoreAudio kAudioDevicePropertyDeviceIsRunningSomewhere
//   • Focus / DND        — ~/Library/DoNotDisturb/DB JSON (fail-OPEN on parse error)
//   • home fingerprint   — gateway MAC via ARP of the default route (permission-free)
//
// Meeting AND-gate (decision Q2): inMeeting = (camera OR mic) AND a frontmost
// meeting app. Camera-alone (Photo Booth, Continuity Camera) must NOT set
// inMeeting — see `PresenceSensing.isMeeting`.
//
// Testability
// ───────────
// The *decision logic* is pure and lives in the nested `PresenceSensing`
// enum + the `RawSignals` struct, so NexusSharedTests can exercise the
// meeting AND-gate, delta emission, and Focus-DB fail-open WITHOUT live
// hardware. The live listeners (which need a real Mac + Aqua session) only
// gather `RawSignals`; all branching that matters is unit-tested.

import Foundation
#if canImport(AppKit)
import AppKit
#endif
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// MARK: - Wire delta

/// A presence delta emitted whenever a sensed signal changes. Mirrors the
/// camelCase keys the agent's `POST /presence/report` accepts (see
/// `apps/agent/src/routes/presence-report.ts`). Only fields that changed since
/// the last emission are non-nil — the executable serializes the non-nil subset.
public struct PresenceDelta: Equatable, Sendable {
    public var macActive: Bool?
    public var macLocked: Bool?
    public var macHost: String?
    public var inMeeting: Bool?
    public var macIdleSec: Double?
    /// Active Focus mode identifier, or `.some(nil)` to explicitly clear Focus.
    /// Double-optional: outer nil = unchanged, inner nil = "no Focus active".
    public var macFocus: String??
    /// Gateway-MAC home fingerprint → agent maps onto `phoneHome` corroborator.
    public var homeHint: Bool?

    public init(
        macActive: Bool? = nil,
        macLocked: Bool? = nil,
        macHost: String? = nil,
        inMeeting: Bool? = nil,
        macIdleSec: Double? = nil,
        macFocus: String?? = nil,
        homeHint: Bool? = nil
    ) {
        self.macActive = macActive
        self.macLocked = macLocked
        self.macHost = macHost
        self.inMeeting = inMeeting
        self.macIdleSec = macIdleSec
        self.macFocus = macFocus
        self.homeHint = homeHint
    }

    /// True when no field changed (nothing to POST).
    public var isEmpty: Bool {
        macActive == nil && macLocked == nil && macHost == nil
            && inMeeting == nil && macIdleSec == nil && macFocus == nil
            && homeHint == nil
    }

    /// The non-nil subset as a JSON-ready dictionary for the `/presence/report`
    /// body. `macFocus` serializes as an explicit `NSNull` when the inner value
    /// is nil (clears Focus); the agent validator accepts `string | null`.
    public func wireBody() -> [String: Any] {
        var body: [String: Any] = [:]
        if let v = macActive { body["macActive"] = v }
        if let v = macLocked { body["macLocked"] = v }
        if let v = macHost { body["macHost"] = v }
        if let v = inMeeting { body["inMeeting"] = v }
        if let v = macIdleSec { body["macIdleSec"] = v }
        if let v = macFocus { body["macFocus"] = v ?? NSNull() }
        if let v = homeHint { body["homeHint"] = v }
        return body
    }
}

// MARK: - Raw signals + pure decision logic (unit-tested)

/// A full snapshot of every sensed signal at one instant. The live listeners
/// fill this in; the pure `PresenceSensing` logic turns two snapshots into a
/// delta. Kept free of any system-framework type so it constructs trivially in
/// tests.
public struct RawSignals: Equatable, Sendable {
    /// Seconds since the last HID event (keyboard/mouse/trackpad).
    public var idleSeconds: Double
    /// True when the screen is locked (login window / screensaver lock).
    public var screenLocked: Bool
    /// True when this session owns the physical console (CGSession on-console).
    public var onConsole: Bool
    /// True when any camera is running somewhere on the system.
    public var cameraInUse: Bool
    /// True when any input audio device is running somewhere.
    public var micInUse: Bool
    /// Bundle id of the frontmost app, or nil when none / unknown.
    public var frontmostBundleId: String?
    /// Active Focus mode id, or nil when no Focus is active / DB unreadable.
    public var focusMode: String?
    /// Gateway-MAC home fingerprint matched the known-home value.
    public var atHome: Bool

    public init(
        idleSeconds: Double = 0,
        screenLocked: Bool = false,
        onConsole: Bool = true,
        cameraInUse: Bool = false,
        micInUse: Bool = false,
        frontmostBundleId: String? = nil,
        focusMode: String? = nil,
        atHome: Bool = false
    ) {
        self.idleSeconds = idleSeconds
        self.screenLocked = screenLocked
        self.onConsole = onConsole
        self.cameraInUse = cameraInUse
        self.micInUse = micInUse
        self.frontmostBundleId = frontmostBundleId
        self.focusMode = focusMode
        self.atHome = atHome
    }
}

/// Pure, hardware-free decision logic. Every branch the spec cares about
/// (meeting AND-gate, active threshold, delta diffing) lives here so it is
/// unit-testable without a live Mac.
public enum PresenceSensing {
    /// Bundle ids treated as "a meeting is in progress" when the camera or mic
    /// is in use AND the app is frontmost. Chrome/Edge cover Google Meet (a web
    /// app has no distinct bundle id, so the browser stands in). Photo Booth /
    /// Continuity Camera are deliberately ABSENT — camera-alone must not gate.
    public static let meetingBundleIds: Set<String> = [
        "us.zoom.xos",                       // Zoom
        "com.microsoft.teams",               // Microsoft Teams (classic)
        "com.microsoft.teams2",              // Microsoft Teams (new)
        "com.google.Chrome",                 // Google Meet (web)
        "com.google.Chrome.canary",
        "com.microsoft.edgemac",             // Meet/Teams web on Edge
        "com.apple.FaceTime",                // FaceTime
        "com.tinyspeck.slackmacgap",         // Slack huddle
        "com.hnc.Discord",                   // Discord call
        "com.webex.meetingmanager",          // Webex
        "Cisco-Systems.Spark",               // Webex (Spark)
    ]

    /// HID idle (seconds) below which the Mac counts as actively used. 60s
    /// matches the agent-side "active" expectation; above it the user has
    /// stepped away from the keyboard even if unlocked.
    public static let activeIdleThreshold: Double = 60

    /// macActive = on-console AND not locked AND under the idle threshold.
    public static func isActive(_ s: RawSignals) -> Bool {
        s.onConsole && !s.screenLocked && s.idleSeconds < activeIdleThreshold
    }

    /// Meeting AND-gate (Q2): a meeting requires BOTH a live capture device
    /// (camera OR mic) AND a known meeting app frontmost. Camera-alone (no
    /// meeting app frontmost) is explicitly NOT a meeting.
    public static func isMeeting(_ s: RawSignals) -> Bool {
        guard s.cameraInUse || s.micInUse else { return false }
        guard let bundle = s.frontmostBundleId else { return false }
        return meetingBundleIds.contains(bundle)
    }

    /// Diff two snapshots into the delta to POST. Only fields whose *derived*
    /// value changed are populated; `host` is stamped on the first delta of a
    /// process so the agent can attribute the vector to this Mac. `idleSeconds`
    /// is coalesced to whole seconds before diffing so sub-second jitter does
    /// not spam reports.
    public static func delta(
        from old: RawSignals?,
        to new: RawSignals,
        host: String,
        isFirst: Bool
    ) -> PresenceDelta {
        var d = PresenceDelta()

        let newActive = isActive(new)
        let newMeeting = isMeeting(new)
        let newIdle = (new.idleSeconds).rounded()

        if isFirst { d.macHost = host }

        if old == nil || isActive(old!) != newActive {
            d.macActive = newActive
        }
        if old == nil || old!.screenLocked != new.screenLocked {
            d.macLocked = new.screenLocked
        }
        if old == nil || isMeeting(old!) != newMeeting {
            d.inMeeting = newMeeting
        }
        if old == nil || (old!.idleSeconds).rounded() != newIdle {
            d.macIdleSec = newIdle
        }
        if old == nil || old!.focusMode != new.focusMode {
            d.macFocus = .some(new.focusMode)
        }
        if old == nil || old!.atHome != new.atHome {
            d.homeHint = new.atHome
        }
        return d
    }

    /// Parse the `~/Library/DoNotDisturb/DB` JSON for the active Focus mode.
    /// FAIL-OPEN (decision / risk): any parse failure or unexpected shape
    /// returns `nil` ("no Focus / unknown") so the sensor never suppresses on a
    /// macOS-version schema drift. Returns the active mode's identifier when a
    /// single assertion is present.
    ///
    /// The DB shape shifts per macOS major; we look for the common
    /// `{ "data": [ { "storeAssertionRecords": [ { "assertionDetails":
    /// { "assertionDetailsModeIdentifier": "<id>" } } ] } ] }` path and treat
    /// anything else (including a top-level array, missing keys, or non-JSON) as
    /// "no Focus active".
    public static func parseFocusMode(fromDB data: Data) -> String? {
        guard
            let root = try? JSONSerialization.jsonObject(with: data),
            let dict = root as? [String: Any]
        else {
            return nil  // fail-open: unreadable / non-object DB → unknown
        }
        guard
            let dataArr = dict["data"] as? [[String: Any]],
            let first = dataArr.first,
            let records = first["storeAssertionRecords"] as? [[String: Any]],
            let rec = records.first,
            let details = rec["assertionDetails"] as? [String: Any],
            let mode = details["assertionDetailsModeIdentifier"] as? String,
            !mode.isEmpty
        else {
            return nil  // no active assertion → no Focus
        }
        return mode
    }
}

// MARK: - Live observer

/// Owns the live macOS listeners and drives `onDelta` whenever a sensed signal
/// changes. The `nexus-presence` executable instantiates this, sets `onDelta`
/// to a `/presence/report` POST, and calls `start()` then `dispatchMain()`.
///
/// Listener lifecycle mirrors SessionObserver: `start()` arms everything,
/// `stop()` tears it down. Camera/mic/lock notifications fire the recompute
/// immediately; idle + gateway-MAC are sampled on a low-frequency timer (idle
/// has no notification API).
public final class PresenceObserver {
    /// Invoked with the non-empty delta on every change. Set by the executable.
    public var onDelta: ((PresenceDelta) -> Void)?

    /// The known-home gateway MAC (lower-cased, colon-separated). When set, the
    /// sensor compares the current default-route gateway MAC against it to
    /// derive `atHome`. Read from the `NX_HOME_GATEWAY_MAC` env by the
    /// executable; nil disables the home fingerprint (atHome stays false).
    private let knownHomeGatewayMAC: String?

    /// Host name stamped on the first delta (`macHost`).
    private let host: String

    /// Poll interval for the signals that have no push notification (idle,
    /// gateway-MAC, camera/mic re-check as a safety net).
    private let pollInterval: TimeInterval

    private var last: RawSignals?
    private var isFirst = true
    private var pollTimer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "dev.leonardoacosta.nexus.presence")
    private var distObservers: [NSObjectProtocol] = []

    public init(
        host: String = ProcessInfo.processInfo.hostName,
        knownHomeGatewayMAC: String? = nil,
        pollInterval: TimeInterval = 5
    ) {
        self.host = host
        self.knownHomeGatewayMAC = knownHomeGatewayMAC?.lowercased()
        self.pollInterval = pollInterval
    }

    // MARK: Lifecycle

    /// Arm lock notifications + the sampling timer and emit a first full delta.
    public func start() {
        armLockNotifications()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: pollInterval)
        timer.setEventHandler { [weak self] in self?.recompute() }
        timer.resume()
        pollTimer = timer
    }

    public func stop() {
        pollTimer?.cancel()
        pollTimer = nil
        // DistributedNotificationCenter is macOS-only; on iOS there are no
        // screen-lock distributed notifications to detach (ios-presence-reporter
        // surfaced this when NexusShared began building for the iOS Simulator).
        #if os(macOS)
        let center = DistributedNotificationCenter.default()
        for obs in distObservers { center.removeObserver(obs) }
        distObservers.removeAll()
        #endif
    }

    // MARK: Recompute + emit

    /// Sample every signal, diff against `last`, and emit if non-empty.
    private func recompute() {
        let signals = sampleSignals()
        let d = PresenceSensing.delta(
            from: last, to: signals, host: host, isFirst: isFirst
        )
        last = signals
        isFirst = false
        if !d.isEmpty {
            onDelta?(d)
        }
    }

    /// Gather a full `RawSignals` snapshot from the live system. The platform
    /// queries are isolated in `#if canImport` extensions below; on a platform
    /// without a given framework the field falls back to a safe default.
    private func sampleSignals() -> RawSignals {
        RawSignals(
            idleSeconds: Self.currentIdleSeconds(),
            screenLocked: Self.isScreenLocked(),
            onConsole: Self.isOnConsole(),
            cameraInUse: Self.isCameraInUse(),
            micInUse: Self.isMicInUse(),
            frontmostBundleId: Self.frontmostBundleId(),
            focusMode: Self.currentFocusMode(),
            atHome: knownHomeGatewayMAC.map { Self.currentGatewayMAC() == $0 } ?? false
        )
    }

    /// Lock/unlock fire instantly via DistributedNotificationCenter; trigger a
    /// recompute on each so `macLocked` is reported without waiting for the
    /// poll tick.
    private func armLockNotifications() {
        // macOS-only: DistributedNotificationCenter + the screenIsLocked/Unlocked
        // names exist only on macOS. On iOS the poll timer alone drives recompute
        // (there is no screen-lock distributed notification to observe).
        #if os(macOS)
        let center = DistributedNotificationCenter.default()
        for name in ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"] {
            let obs = center.addObserver(
                forName: Notification.Name(name),
                object: nil,
                queue: nil
            ) { [weak self] _ in
                self?.queue.async { self?.recompute() }
            }
            distObservers.append(obs)
        }
        #endif
    }
}

// MARK: - Live system queries (macOS)
//
// Each static returns a safe fallback on a platform lacking the framework so
// NexusShared still compiles for iOS / watchOS (where this observer is never
// instantiated). The real sensing path is macOS-only.

extension PresenceObserver {

    /// HID idle seconds via CGEventSource. Falls back to 0 (treated as active)
    /// when CoreGraphics is unavailable or the query fails.
    static func currentIdleSeconds() -> Double {
        #if canImport(CoreGraphics) && os(macOS)
        // .combinedSessionState covers keyboard + mouse + trackpad events.
        let idle = CGEventSource.secondsSinceLastEventType(
            .combinedSessionState,
            eventType: .init(rawValue: ~0)!  // kCGAnyInputEventType
        )
        return idle.isFinite ? max(0, idle) : 0
        #else
        return 0
        #endif
    }

    /// Screen-lock state. CGSession's dictionary carries
    /// `CGSSessionScreenIsLocked` when the session is locked.
    static func isScreenLocked() -> Bool {
        #if os(macOS)
        guard
            let info = CGSessionCopyCurrentDictionary() as? [String: Any]
        else { return false }
        if let locked = info["CGSSessionScreenIsLocked"] as? Bool {
            return locked
        }
        // Some macOS versions surface it as an NSNumber 1/0.
        if let n = info["CGSSessionScreenIsLocked"] as? NSNumber {
            return n.boolValue
        }
        return false
        #else
        return false
        #endif
    }

    /// Console ownership — `kCGSSessionOnConsoleKey` ("kCGSSessionOnConsoleKey")
    /// is true when this session owns the physical display/keyboard.
    static func isOnConsole() -> Bool {
        #if os(macOS)
        guard
            let info = CGSessionCopyCurrentDictionary() as? [String: Any]
        else { return true }  // fail-open: assume on-console
        if let onConsole = info["kCGSSessionOnConsoleKey"] as? Bool {
            return onConsole
        }
        if let n = info["kCGSSessionOnConsoleKey"] as? NSNumber {
            return n.boolValue
        }
        return true
        #else
        return true
        #endif
    }

    /// Camera in use anywhere on the system, via CoreMediaIO's
    /// `kCMIODevicePropertyDeviceIsRunningSomewhere` across all video devices.
    static func isCameraInUse() -> Bool {
        #if os(macOS) && canImport(CoreMediaIO)
        return CMIOIsAnyCameraRunning()
        #else
        return false
        #endif
    }

    /// Mic in use anywhere, via CoreAudio's
    /// `kAudioDevicePropertyDeviceIsRunningSomewhere` across input devices.
    static func isMicInUse() -> Bool {
        #if os(macOS) && canImport(CoreAudio)
        return CoreAudioIsAnyInputRunning()
        #else
        return false
        #endif
    }

    /// Bundle id of the frontmost app (NSWorkspace). nil off macOS / when none.
    static func frontmostBundleId() -> String? {
        #if canImport(AppKit) && os(macOS)
        return NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        #else
        return nil
        #endif
    }

    /// Active Focus mode from `~/Library/DoNotDisturb/DB`. Fail-open: missing
    /// file / unreadable / parse error → nil (no Focus). Parsing is delegated
    /// to the unit-tested `PresenceSensing.parseFocusMode`.
    static func currentFocusMode() -> String? {
        #if os(macOS)
        let path = ("~/Library/DoNotDisturb/DB" as NSString)
            .expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path) else {
            return nil
        }
        return PresenceSensing.parseFocusMode(fromDB: data)
        #else
        return nil
        #endif
    }

    /// Gateway MAC of the default route via `arp` of the gateway IP — a
    /// permission-free home fingerprint. Returns a lower-cased colon-separated
    /// MAC, or empty string when it can't be resolved (never matches a known
    /// home MAC, so atHome stays false).
    static func currentGatewayMAC() -> String {
        #if os(macOS)
        guard let gatewayIP = defaultGatewayIP(), !gatewayIP.isEmpty else {
            return ""
        }
        // `arp -n <ip>` prints e.g. "? (192.168.1.1) at a4:b1:c1:... on en0".
        guard let out = runTool("/usr/sbin/arp", ["-n", gatewayIP]) else {
            return ""
        }
        return parseMAC(fromARP: out)
        #else
        return ""
        #endif
    }

    /// Default-route gateway IP from `route -n get default`. nil when unset.
    static func defaultGatewayIP() -> String? {
        #if os(macOS)
        guard let out = runTool("/sbin/route", ["-n", "get", "default"]) else {
            return nil
        }
        for line in out.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("gateway:") {
                return trimmed
                    .replacingOccurrences(of: "gateway:", with: "")
                    .trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
        #else
        return nil
        #endif
    }

    /// Pull the MAC out of an `arp` line. Returns lower-cased colon-form, or "".
    static func parseMAC(fromARP text: String) -> String {
        // Look for the token after "at".
        let tokens = text.split(whereSeparator: { $0 == " " || $0 == "\n" })
        for (i, tok) in tokens.enumerated() where tok == "at" {
            if i + 1 < tokens.count {
                let candidate = String(tokens[i + 1])
                if candidate.contains(":") && candidate != "(incomplete)" {
                    // Normalise each octet to two-digit lower-case hex so
                    // `a4:b1:c` and `a4:b1:0c` compare equal to the known value.
                    let octets = candidate.split(separator: ":").map { oct -> String in
                        let s = String(oct).lowercased()
                        return s.count == 1 ? "0\(s)" : s
                    }
                    return octets.joined(separator: ":")
                }
            }
        }
        return ""
    }

    /// Run a CLI tool, capturing stdout. nil on launch failure / non-zero exit.
    static func runTool(_ launchPath: String, _ args: [String]) -> String? {
        #if os(macOS)
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8)
        #else
        return nil
        #endif
    }
}

#if os(macOS) && canImport(CoreMediaIO)
import CoreMediaIO

/// True when any CMIO video device reports
/// `kCMIODevicePropertyDeviceIsRunningSomewhere == 1`. Requires the Aqua
/// session (gui/501) for accurate results — the LaunchAgent provides it.
private func CMIOIsAnyCameraRunning() -> Bool {
    var dataSize: UInt32 = 0
    var devicesAddress = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    guard CMIOObjectGetPropertyDataSize(
        CMIOObjectID(kCMIOObjectSystemObject), &devicesAddress, 0, nil, &dataSize
    ) == 0, dataSize > 0 else { return false }

    let count = Int(dataSize) / MemoryLayout<CMIOObjectID>.size
    var devices = [CMIOObjectID](repeating: 0, count: count)
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(
        CMIOObjectID(kCMIOObjectSystemObject), &devicesAddress, 0, nil,
        dataSize, &used, &devices
    ) == 0 else { return false }

    var runningAddress = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    for device in devices {
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        if CMIOObjectGetPropertyData(
            device, &runningAddress, 0, nil, size, &size, &running
        ) == 0, running != 0 {
            return true
        }
    }
    return false
}
#endif

#if os(macOS) && canImport(CoreAudio)
import CoreAudio

/// True when any audio INPUT device reports
/// `kAudioDevicePropertyDeviceIsRunningSomewhere == 1`.
private func CoreAudioIsAnyInputRunning() -> Bool {
    var dataSize: UInt32 = 0
    var devicesAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &dataSize
    ) == noErr, dataSize > 0 else { return false }

    let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
    var devices = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil,
        &dataSize, &devices
    ) == noErr else { return false }

    for device in devices {
        // Only consider devices with input channels (a mic).
        var streamAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            device, &streamAddress, 0, nil, &streamSize
        ) == noErr, streamSize > 0 else { continue }

        var runningAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        if AudioObjectGetPropertyData(
            device, &runningAddress, 0, nil, &size, &running
        ) == noErr, running != 0 {
            return true
        }
    }
    return false
}
#endif
