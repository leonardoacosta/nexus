// PresenceReporter — reports the two phone-only presence signals the homelab
// agent cannot derive itself: whether the phone is in its BEDTIME window
// (HealthKit sleep schedule) and whether a Focus is active (INFocusStatusCenter).
//
// Spec: openspec/changes/ios-presence-reporter (Phase 2, nx-eqsz9).
//
// The phone POSTs { machine, hkSleepWindow, sleepFocusActive, phoneFocusOn } to
// the agent's POST /presence/report. The agent keeps these in a GLOBAL phone
// record (there is one phone) and computes `isBedtime` from the configurable
// `bedtime_sources` policy — so the reporter sends RAW signals, not a decision.
//
// EVENT-DRIVEN, never polling (iOS background reality, design §"iOS background
// reality"): three wake paths feed the same `report()`:
//   1. HKObserverQuery wake for .sleepAnalysis (sleep schedule changed)
//   2. INFocusStatusCenter authorizationStatus/status change observer (Focus)
//   3. app foreground (NexusAppDelegate hook)
//
// HK SLEEP-SCHEDULE APPROACH (documented decision): iOS exposes no public
// forward-looking "is my Sleep schedule active right now" API
// (HKCharacteristicType has no sleep-schedule entry; the schedule lives in the
// private Health/Bedtime store). So `hkSleepWindow` is DERIVED from the most
// recent .sleepAnalysis category samples: if a recent inBed/asleep* interval
// CONTAINS now (or ends within a short grace window around now), the phone is
// treated as in its sleep window. This reuses the granted HealthKit auth +
// HKObserver wake that `HealthKitPushManager` already wires for .sleepAnalysis,
// and degrades cleanly to `false` when no schedule/samples exist (the
// `either`/`focus` bedtime policies still work via the Sleep Focus signal).
//
// The decision logic (in-window computation + payload build) is factored into
// PURE, injectable functions (`SleepWindow`, `PresencePayload`) so it unit-tests
// with fixtures — no live HealthKit / Focus hardware required.

import Foundation

#if canImport(HealthKit)
import HealthKit
#endif
#if canImport(Intents)
import Intents
#endif
#if canImport(UIKit)
import UIKit
#endif
import os.log
import NexusShared

// MARK: - Pure logic (headless-testable, no hardware)

/// A single sleep interval read from HealthKit (`.sleepAnalysis` sample).
/// `asleep` distinguishes an actual asleep/in-bed stage from a non-sleep value;
/// only sleeping/in-bed intervals count toward the bedtime window.
public struct SleepInterval: Equatable, Sendable {
    public let start: Date
    public let end: Date
    /// True for inBed / asleep* category values (a real sleep window), false for
    /// `.awake` and any non-sleep value.
    public let asleep: Bool

    public init(start: Date, end: Date, asleep: Bool) {
        self.start = start
        self.end = end
        self.asleep = asleep
    }
}

/// Pure bedtime-window evaluation over a set of sleep intervals.
public enum SleepWindow {
    /// A short grace appended to the end of the most recent interval: if you
    /// woke up <= this ago we still treat you as "just within" the window, so a
    /// brief stir doesn't immediately flip bedtime off before the next wake.
    public static let graceAfterEnd: TimeInterval = 30 * 60 // 30 minutes

    /// `true` when `now` falls inside any asleep/in-bed interval, OR within the
    /// grace window just after the most recent one ended. `intervals` need not be
    /// sorted. Non-asleep intervals (`.awake`) never establish a window.
    public static func isInWindow(
        at now: Date,
        intervals: [SleepInterval],
        grace: TimeInterval = graceAfterEnd
    ) -> Bool {
        for iv in intervals where iv.asleep {
            // Inside the interval [start, end].
            if now >= iv.start && now <= iv.end { return true }
            // Within the grace window just after it ended.
            if now > iv.end && now <= iv.end.addingTimeInterval(grace) { return true }
        }
        return false
    }
}

/// The presence report payload the agent's POST /presence/report accepts for the
/// phone. Pure value type so the build + keys are unit-testable.
public struct PresencePayload: Equatable, Sendable {
    public let machine: String
    public let hkSleepWindow: Bool
    public let sleepFocusActive: Bool
    public let phoneFocusOn: Bool

    public init(
        machine: String,
        hkSleepWindow: Bool,
        sleepFocusActive: Bool,
        phoneFocusOn: Bool
    ) {
        self.machine = machine
        self.hkSleepWindow = hkSleepWindow
        self.sleepFocusActive = sleepFocusActive
        self.phoneFocusOn = phoneFocusOn
    }

    /// The exact wire shape (`[String: Any]`) `NexusClient.reportPresence` POSTs.
    /// Keys MUST match the agent's `presence-report.ts` allow-list:
    /// machine / hkSleepWindow / sleepFocusActive / phoneFocusOn.
    public var body: [String: Any] {
        [
            "machine": machine,
            "hkSleepWindow": hkSleepWindow,
            "sleepFocusActive": sleepFocusActive,
            "phoneFocusOn": phoneFocusOn,
        ]
    }
}

// MARK: - Reporter actor (live HealthKit + Focus, event-driven)

#if canImport(HealthKit) && canImport(Intents) && os(iOS)
@available(iOS 16.0, *)
actor PresenceReporter {
    static let shared = PresenceReporter()

    private let store = HKHealthStore()
    private let client: NexusShared.NexusClient
    private let log = Logger(
        subsystem: "dev.leonardoacosta.nexus.ios",
        category: "presence-reporter"
    )

    init() {
        // `Self.resolvedEndpoint()` can't be referenced from a stored-property
        // initializer (covariant Self), so resolve the endpoint here.
        self.client = NexusShared.NexusClient(endpoint: PresenceReporter.resolvedEndpoint())
    }

    /// Guards one-time observer registration per PROCESS (iOS spawns a fresh
    /// process per background wake, so this resets naturally).
    private var started = false

    /// How far back to scan .sleepAnalysis for the most recent window.
    private static let sleepLookback: TimeInterval = 18 * 60 * 60 // 18h

    // MARK: Lifecycle

    /// Bootstrap on launch: request HealthKit + Focus authorization, register the
    /// sleep-schedule HKObserver + the Focus-status-change observer, then emit an
    /// initial report. Safe to call repeatedly (idempotent observer guard).
    func start() async {
        await requestAuthorization()
        if !started {
            registerSleepObserver()
            registerFocusObserver()
            started = true
        }
        await report()
    }

    /// Re-emit on app foreground (called from NexusAppDelegate). Cheap: reads the
    /// current signals and POSTs. Does NOT re-register observers.
    func reportNow() async {
        await report()
    }

    // MARK: Authorization

    private func requestAuthorization() async {
        // HealthKit .sleepAnalysis read (already granted via HealthKitPushManager's
        // full-catalog request, but request narrowly here too so the reporter
        // works even if launched into a context the push manager didn't run).
        if HKHealthStore.isHealthDataAvailable(),
           let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            do {
                try await store.requestAuthorization(toShare: [], read: [sleepType])
            } catch {
                log.error("HealthKit sleep auth failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        // Focus status (Communication Notifications entitlement). Best-effort:
        // the user may decline, in which case status reads .notDetermined/false.
        let center = INFocusStatusCenter.default
        if center.authorizationStatus == .notDetermined {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                center.requestAuthorization { _ in cont.resume() }
            }
        }
    }

    // MARK: Observers (event-driven, no polling)

    private func registerSleepObserver() {
        guard HKHealthStore.isHealthDataAvailable(),
              let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            return
        }
        let observer = HKObserverQuery(sampleType: sleepType, predicate: nil) { [weak self] _, completion, error in
            guard let self else { completion(); return }
            if error != nil { completion(); return }
            Task {
                await self.report()
                completion()
            }
        }
        store.execute(observer)
        // Background delivery so a sleep-schedule change wakes the app even when
        // backgrounded (HealthKitPushManager enables this too; HealthKit dedupes).
        store.enableBackgroundDelivery(for: sleepType, frequency: .immediate) { [weak self] _, error in
            if let error {
                self?.log.error("sleep background delivery failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func registerFocusObserver() {
        // INFocusStatusCenter has no KVO/delegate; it posts a Darwin/Notification
        // when the SHARED Focus status changes. Observe the documented name so a
        // Focus toggle (incl. Sleep Focus) re-emits a report.
        NotificationCenter.default.addObserver(
            forName: .init("INFocusStatusCenterDidChange"),
            object: nil,
            queue: nil
        ) { [weak self] _ in
            Task { await self?.report() }
        }
    }

    // MARK: Read + report

    /// Read the current signals (HK sleep window + Focus) and POST them. The
    /// decision logic itself is pure (`SleepWindow` / `PresencePayload`); this
    /// method only does the live reads + transport.
    private func report() async {
        let now = Date()
        let intervals = await fetchRecentSleepIntervals(now: now)
        let hkSleepWindow = SleepWindow.isInWindow(at: now, intervals: intervals)

        let focus = INFocusStatusCenter.default.focusStatus
        // `isFocused == true` means a Focus is active; nil/false means none or
        // unauthorized (best-effort, fail-open to "no Focus").
        let phoneFocusOn = focus.isFocused == true
        // No public API distinguishes WHICH Focus is active, so Sleep-Focus is
        // approximated by "a Focus is on" — the agent's bedtime policy combines
        // it with the HK signal per `bedtime_sources`. When richer Focus identity
        // lands this can narrow to the Sleep Focus specifically.
        let sleepFocusActive = phoneFocusOn

        let payload = PresencePayload(
            machine: Self.machineIdentity(),
            hkSleepWindow: hkSleepWindow,
            sleepFocusActive: sleepFocusActive,
            phoneFocusOn: phoneFocusOn
        )
        _ = await client.reportPresence(payload.body)
        log.debug(
            "presence reported hkSleepWindow=\(hkSleepWindow, privacy: .public) focus=\(phoneFocusOn, privacy: .public)"
        )
    }

    /// Fetch the most-recent `.sleepAnalysis` samples in the lookback window and
    /// map them to `SleepInterval`s for the pure evaluator.
    private func fetchRecentSleepIntervals(now: Date) async -> [SleepInterval] {
        guard let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            return []
        }
        let start = now.addingTimeInterval(-Self.sleepLookback)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now.addingTimeInterval(60), options: [])
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        let samples: [HKSample] = await withCheckedContinuation { cont in
            let q = HKSampleQuery(
                sampleType: sleepType,
                predicate: predicate,
                limit: 200,
                sortDescriptors: [sort]
            ) { _, result, _ in
                cont.resume(returning: result ?? [])
            }
            store.execute(q)
        }
        return samples.compactMap { sample in
            guard let c = sample as? HKCategorySample else { return nil }
            return SleepInterval(start: c.startDate, end: c.endDate, asleep: Self.isAsleep(c.value))
        }
    }

    /// Map an `HKCategoryValueSleepAnalysis` raw value to "counts as a sleep
    /// window". inBed + every asleep* stage count; `.awake` does not.
    static func isAsleep(_ rawValue: Int) -> Bool {
        guard let v = HKCategoryValueSleepAnalysis(rawValue: rawValue) else { return false }
        switch v {
        case .inBed, .asleepUnspecified, .asleepCore, .asleepDeep, .asleepREM:
            return true
        case .awake:
            return false
        @unknown default:
            return false
        }
    }

    // MARK: Identity + endpoint

    /// The phone's machine identity sent as `machine` (informational; the agent
    /// keys phone signals into a single GLOBAL phone record regardless).
    static func machineIdentity() -> String {
        #if canImport(UIKit)
        let name = UIDevice.current.name
        if !name.isEmpty { return name }
        #endif
        return "iphone"
    }

    /// Resolve the agent endpoint from Info.plist `NEXUS_ENDPOINT` (homelab over
    /// the tailnet), mirroring ApnsRegistrar. Falls back to homelab:7400.
    static func resolvedEndpoint() -> NexusEndpoint {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "NEXUS_ENDPOINT") as? String,
           let url = URL(string: raw) {
            return NexusEndpoint(baseURL: url)
        }
        return NexusEndpoint(baseURL: URL(string: "http://homelab:7400")!)
    }
}
#endif
