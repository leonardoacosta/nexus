// HealthKitPushManager — reads ALL Apple Health data and PUSHES it to a LIST of
// ingest targets: the homelab mx-health endpoint over the tailnet AND the
// Apothecary (ap) health-metric ingest over HTTPS.
//
// This is the PRODUCTION producer for the mx mesh's src-health capability
// (mx repo: mx-sqd / mx-4d0) and the producer side of Apothecary's
// add-health-metric-ingest. It reads HealthKit directly from inside the Nexus
// app — already on the phone, already on the tailnet — and POSTs the SAME Health
// Auto Export JSON shape to EVERY target. Both backends accept it: the homelab
// decoder (mx internal/health/ingest.go) and ap's /api/health/ingest route both
// parse {data:{metrics:[{name,units,data:[{date,start?,qty,source}]}]}}.
//
// DUAL-PUSH SEMANTICS: each chunk is POSTed to ALL targets and the per-stream
// HealthKit anchor advances ONLY when EVERY target returns 2xx. Both backends
// dedup (mx synthesizes a stable key from metric+date+source; ap from
// metric+start+end+source+qty), so a partial failure safely re-pushes the whole
// batch on the next wake without creating duplicate rows.
//
// ALL METRICS, ALL SOURCES: HealthKit is the SHARED store every device writes
// into — Apple Watch, WHOOP, Oura, third-party apps all land here under standard
// type identifiers. So reading the full type catalog captures third-party-device
// data automatically; each sample is tagged with its originating
// `sourceRevision.source.name` (stored homelab-side as source_device). There is no
// separate third-party API to integrate.
//
// The homelab side needs ZERO changes for new metrics: its decoder + store are
// generic (metric_type is just a string), so every quantity/category type flows
// in as-is. Only resting_heart_rate currently drives a derived signal; everything
// else is captured as raw samples (the two-table split keeps them off the triage
// hot path until a rule wants them).
//
// NOTE ON NAMING: distinct from the nexus "health" SYSTEM-metrics surface
// (HealthSummaryScene / HealthCollector = CPU/mem/disk). This is Apple biometrics.
//
// Self-contained (Foundation + HealthKit only) so it type-checks in isolation.

import Foundation
import HealthKit
import os.log

@available(iOS 15.0, *)
actor HealthKitPushManager {
    static let shared = HealthKitPushManager()

    private let store = HKHealthStore()
    private let log = Logger(subsystem: "dev.leonardoacosta.nexus.ios", category: "healthkit-push")

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 120
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    /// Health Auto Export's timestamp layout: "2026-06-07 06:05:00 -0500". POSIX
    /// locale + the `Z` token emit the numeric GMT offset the Go decoder layout
    /// "2006-01-02 15:04:05 -0700" parses.
    private let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        return f
    }()

    /// A push stream for one HealthKit sample type. `unit` is set for quantity
    /// types (resolved from the user's preferred units) and nil for category types
    /// (their value is an enum int, pushed as `qty`).
    private struct Stream {
        let sampleType: HKSampleType
        let exportName: String
        let unit: HKUnit?
        let unitString: String
    }

    private var streams: [Stream] = []

    /// Guards one-time observer registration per PROCESS. iOS launches a fresh
    /// process for each background wake, so this resets naturally; within a single
    /// process we register HKObserverQuery once (re-registering would leak queries).
    private var observersRegistered = false

    // MARK: - Type catalog
    //
    // HealthKit has no "all identifiers" API, so the catalog is enumerated. These
    // are the broadly-supported (iOS <= 15) quantity types across every domain —
    // heart, body, activity/energy, mobility, respiratory, vitals, audio/UV, and
    // the full nutrition set. Newer iOS 16+ identifiers (running power/speed,
    // wrist temperature, etc.) can be appended behind `if #available` later.

    private static let quantityIdentifiers: [HKQuantityTypeIdentifier] = [
        // Heart / circulatory
        .heartRate, .restingHeartRate, .walkingHeartRateAverage, .heartRateVariabilitySDNN,
        .oxygenSaturation, .peripheralPerfusionIndex, .bloodPressureSystolic,
        .bloodPressureDiastolic, .vo2Max,
        // Body measurements
        .bodyMass, .bodyMassIndex, .bodyFatPercentage, .leanBodyMass, .height,
        .waistCircumference, .bodyTemperature, .basalBodyTemperature,
        // Activity / energy
        .stepCount, .distanceWalkingRunning, .distanceCycling, .distanceSwimming,
        .distanceWheelchair, .distanceDownhillSnowSports, .pushCount, .swimmingStrokeCount,
        .basalEnergyBurned, .activeEnergyBurned, .flightsClimbed, .appleExerciseTime,
        .appleStandTime, .nikeFuel,
        // Mobility
        .walkingSpeed, .walkingStepLength, .walkingAsymmetryPercentage,
        .walkingDoubleSupportPercentage, .sixMinuteWalkTestDistance,
        .stairAscentSpeed, .stairDescentSpeed,
        // Respiratory
        .respiratoryRate, .forcedVitalCapacity, .forcedExpiratoryVolume1,
        .peakExpiratoryFlowRate, .inhalerUsage,
        // Lab / vitals
        .bloodGlucose, .bloodAlcoholContent, .numberOfTimesFallen, .electrodermalActivity,
        .insulinDelivery,
        // Audio / UV exposure
        .environmentalAudioExposure, .headphoneAudioExposure, .uvExposure,
        // Nutrition (full set)
        .dietaryEnergyConsumed, .dietaryCarbohydrates, .dietaryFiber, .dietarySugar,
        .dietaryFatTotal, .dietaryFatSaturated, .dietaryFatPolyunsaturated,
        .dietaryFatMonounsaturated, .dietaryCholesterol, .dietaryProtein, .dietarySodium,
        .dietaryPotassium, .dietaryCalcium, .dietaryIron, .dietaryVitaminA, .dietaryVitaminB6,
        .dietaryVitaminB12, .dietaryVitaminC, .dietaryVitaminD, .dietaryVitaminE,
        .dietaryVitaminK, .dietaryThiamin, .dietaryRiboflavin, .dietaryNiacin, .dietaryFolate,
        .dietaryBiotin, .dietaryPantothenicAcid, .dietaryPhosphorus, .dietaryIodine,
        .dietaryMagnesium, .dietaryZinc, .dietarySelenium, .dietaryCopper, .dietaryManganese,
        .dietaryChromium, .dietaryMolybdenum, .dietaryChloride, .dietaryWater, .dietaryCaffeine,
    ]

    private static let categoryIdentifiers: [HKCategoryTypeIdentifier] = [
        .sleepAnalysis, .mindfulSession, .appleStandHour,
        .highHeartRateEvent, .lowHeartRateEvent, .irregularHeartRhythmEvent,
        .toothbrushingEvent, .handwashingEvent,
    ]

    private var quantityTypes: [HKQuantityType] {
        Self.quantityIdentifiers.compactMap { HKObjectType.quantityType(forIdentifier: $0) }
    }
    private var categoryTypes: [HKCategoryType] {
        Self.categoryIdentifiers.compactMap { HKObjectType.categoryType(forIdentifier: $0) }
    }

    // MARK: - Lifecycle

    /// Bootstrap on app launch: request read auth for the whole catalog, resolve
    /// units, build the streams, then register a background observer + do an
    /// initial anchored flush for each. Safe to call repeatedly.
    func bootstrap() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            log.info("HealthKit unavailable on this device; push disabled")
            return
        }
        do {
            try await requestAuthorization()
        } catch {
            log.error("HealthKit authorization failed: \(error.localizedDescription, privacy: .public)")
            return
        }
        await buildStreams()
        log.info("HealthKit push: \(self.streams.count) streams registered")
        if !observersRegistered {
            for stream in streams { registerObserver(for: stream) }
            observersRegistered = true
        }
        for stream in streams { await flush(stream) }
    }

    /// flushAll is the shared entry point for the BACKGROUND triggers
    /// (BGTaskScheduler + silent APNS push). It ensures the stream catalog is built
    /// (a background-launched process may not have run a full bootstrap yet) then
    /// flushes every stream's new samples. It does NOT register observers — that is
    /// bootstrap's job, guarded to run once per process.
    func flushAll() async {
        if streams.isEmpty {
            guard HKHealthStore.isHealthDataAvailable() else { return }
            await buildStreams()
        }
        for stream in streams { await flush(stream) }
    }

    /// Request READ authorization for EVERY type in the catalog (we never write —
    /// toShare is empty). One permission sheet covers the lot.
    func requestAuthorization() async throws {
        let read: Set<HKObjectType> = Set(quantityTypes as [HKObjectType])
            .union(categoryTypes as [HKObjectType])
        try await store.requestAuthorization(toShare: [], read: read)
    }

    /// Resolve the user's preferred unit per quantity type, then assemble the
    /// stream list (quantity streams + category streams). Names are derived from
    /// the type identifier so the catalog needs no parallel name table.
    private func buildStreams() async {
        let qTypes = quantityTypes
        var units: [HKQuantityType: HKUnit] = [:]
        do {
            units = try await store.preferredUnits(for: Set(qTypes))
        } catch {
            log.error("preferredUnits failed: \(error.localizedDescription, privacy: .public)")
        }

        var built: [Stream] = []
        for type in qTypes {
            guard let unit = units[type] else { continue } // skip types with no resolvable unit
            built.append(Stream(
                sampleType: type,
                exportName: Self.exportName(from: type.identifier),
                unit: unit,
                unitString: unit.unitString
            ))
        }
        for type in categoryTypes {
            built.append(Stream(
                sampleType: type,
                exportName: Self.exportName(from: type.identifier),
                unit: nil,
                unitString: ""
            ))
        }
        streams = built
    }

    /// "HKQuantityTypeIdentifierRestingHeartRate" -> "resting_heart_rate".
    static func exportName(from identifier: String) -> String {
        var s = identifier
        for prefix in ["HKQuantityTypeIdentifier", "HKCategoryTypeIdentifier"] where s.hasPrefix(prefix) {
            s.removeFirst(prefix.count)
            break
        }
        var out = ""
        for ch in s {
            if ch.isUppercase {
                if !out.isEmpty { out.append("_") }
                out.append(contentsOf: ch.lowercased())
            } else {
                out.append(ch)
            }
        }
        return out
    }

    // MARK: - Observers + background delivery

    private func registerObserver(for stream: Stream) {
        let observer = HKObserverQuery(sampleType: stream.sampleType, predicate: nil) { [weak self] _, completionHandler, error in
            guard let self else { completionHandler(); return }
            if let error {
                Task { await self.logObserverError(name: stream.exportName, error: error) }
                completionHandler()
                return
            }
            // Flush, THEN call the background-delivery completion so the system
            // keeps delivering wakes for this type.
            Task {
                await self.flush(stream)
                completionHandler()
            }
        }
        store.execute(observer)
        store.enableBackgroundDelivery(for: stream.sampleType, frequency: .hourly) { [weak self] success, error in
            guard let self else { return }
            Task { await self.logBackgroundDelivery(name: stream.exportName, success: success, error: error) }
        }
    }

    private func logObserverError(name: String, error: Error) {
        log.error("observer error for \(name, privacy: .public): \(error.localizedDescription, privacy: .public)")
    }

    private func logBackgroundDelivery(name: String, success: Bool, error: Error?) {
        if let error {
            log.error("background delivery for \(name, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Anchored fetch + push

    /// Fetch new samples since the persisted anchor, push them, and advance the
    /// anchor only on a 2xx so failures retry next wake.
    private func flush(_ stream: Stream) async {
        let anchor = loadAnchor(for: stream.sampleType.identifier)
        let (samples, newAnchor) = await fetchSamples(type: stream.sampleType, anchor: anchor)
        guard !samples.isEmpty else { return }
        let pushed = await push(stream: stream, samples: samples)
        if pushed, let newAnchor {
            saveAnchor(newAnchor, for: stream.sampleType.identifier)
        }
    }

    private func fetchSamples(type: HKSampleType, anchor: HKQueryAnchor?) async -> ([HKSample], HKQueryAnchor?) {
        await withCheckedContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: type,
                predicate: nil,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samplesOrNil, _, newAnchor, _ in
                continuation.resume(returning: (samplesOrNil ?? [], newAnchor))
            }
            store.execute(query)
        }
    }

    /// Max samples per POST. High-frequency types (heart_rate, step_count) can have
    /// hundreds of thousands of historical samples; one giant body would exceed the
    /// homelab's 32 MiB ingest cap, so the initial backfill is chunked. Re-push is
    /// idempotent (the homelab synthesizes a stable key from metric+date+source), so
    /// a partial-batch failure just re-sends safely next wake.
    private static let pushChunkSize = 5_000

    /// Encode each sample once, then POST in chunks. Quantity samples push their
    /// value in the stream's unit; category samples push their enum value as `qty`.
    /// Returns true only if EVERY chunk got a 2xx (so the anchor advances only when
    /// all of this batch is durably stored).
    private func push(stream: Stream, samples: [HKSample]) async -> Bool {
        let data: [[String: Any]] = samples.compactMap { sample in
            guard let value = self.value(of: sample, in: stream) else { return nil }
            // `date` is the sample's END instant (HAE convention); `start` is its
            // START instant. ap stores the [start,end] interval (reads `start`
            // optionally, falling back to `date`); mx ignores the extra `start`
            // key (its decoder uses no DisallowUnknownFields). Instant samples
            // have start == end, so this is a no-op for them on both backends.
            return [
                "date": dateFormatter.string(from: sample.endDate),
                "start": dateFormatter.string(from: sample.startDate),
                "qty": value,
                "source": sample.sourceRevision.source.name,
            ]
        }
        guard !data.isEmpty else { return true } // nothing extractable — treat as handled

        var pushed = 0
        var index = 0
        while index < data.count {
            let chunk = Array(data[index ..< min(index + Self.pushChunkSize, data.count)])
            if await postChunk(stream: stream, chunk: chunk) {
                pushed += chunk.count
                index += chunk.count
            } else {
                log.error("ingest chunk failed for \(stream.exportName, privacy: .public) at \(index)/\(data.count)")
                return false
            }
        }
        log.info("pushed \(pushed) \(stream.exportName, privacy: .public) sample(s)")
        return true
    }

    /// POST one chunk to EVERY ingest target. Returns true only if ALL targets
    /// returned 2xx, so the caller advances the anchor only when the chunk is
    /// durably stored everywhere. A single target failing leaves the whole chunk
    /// un-acked → it re-pushes to all targets next wake (both backends dedup).
    private func postChunk(stream: Stream, chunk: [[String: Any]]) async -> Bool {
        let envelope: [String: Any] = [
            "data": ["metrics": [[
                "name": stream.exportName,
                "units": stream.unitString,
                "data": chunk,
            ]]]
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: envelope) else {
            log.error("failed to encode \(stream.exportName, privacy: .public) envelope")
            return false
        }

        let targets = Self.ingestTargets()
        guard !targets.isEmpty else {
            log.error("no ingest targets resolved for \(stream.exportName, privacy: .public)")
            return false
        }

        var allOK = true
        for target in targets {
            let ok = await postChunk(body: body, to: target, exportName: stream.exportName)
            if !ok { allOK = false } // keep posting the rest; require ALL 2xx to ack
        }
        return allOK
    }

    /// POST an already-encoded body to one target. Isolated so the per-target
    /// failure is logged with its host and a partial dual-push is observable.
    private func postChunk(body: Data, to target: IngestTarget, exportName: String) async -> Bool {
        var request = URLRequest(url: target.url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = target.token {
            request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body

        let host = target.url.host ?? target.url.absoluteString
        do {
            let (_, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200...299).contains(code) { return true }
            log.error("ingest \(host, privacy: .public) returned \(code) for \(exportName, privacy: .public)")
            return false
        } catch {
            log.error("ingest \(host, privacy: .public) POST failed for \(exportName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Numeric value for a sample: quantity in the stream unit, or a category enum
    /// value as a Double.
    private func value(of sample: HKSample, in stream: Stream) -> Double? {
        if let q = sample as? HKQuantitySample, let unit = stream.unit {
            return q.quantity.doubleValue(for: unit)
        }
        if let c = sample as? HKCategorySample {
            return Double(c.value)
        }
        return nil
    }

    // MARK: - Endpoint resolution (Info.plist, homelab fallback)

    /// One (endpoint, bearer-token) ingest destination. A nil token means the
    /// target is hit without an Authorization header (the mx homelab target is
    /// currently tokenless on the tailnet).
    private struct IngestTarget {
        let url: URL
        let token: String?
    }

    /// Resolve the full list of ingest targets from the Info.plist:
    ///   - mx homelab  (HEALTH_INGEST_ENDPOINT, default http://homelab:8798/ingest;
    ///                  optional HEALTH_INGEST_TOKEN)
    ///   - Apothecary  (HEALTH_INGEST_ENDPOINT_AP + HEALTH_INGEST_TOKEN_AP)
    /// The mx target always resolves (it has a hardcoded fallback). The ap target
    /// is added only when BOTH its endpoint and a non-empty token are present, so
    /// a build without the gitignored Secrets.xcconfig degrades to mx-only rather
    /// than POSTing to ap unauthenticated (which ap 401s).
    private static func ingestTargets() -> [IngestTarget] {
        var targets: [IngestTarget] = []

        // mx homelab target (existing behaviour, tailnet, optional token).
        let mxURL = plistString("HEALTH_INGEST_ENDPOINT").flatMap(URL.init(string:))
            ?? URL(string: "http://homelab:8798/ingest")!
        targets.append(IngestTarget(url: mxURL, token: plistString("HEALTH_INGEST_TOKEN")))

        // Apothecary target (additive; HTTPS; requires a token).
        if let apRaw = plistString("HEALTH_INGEST_ENDPOINT_AP"),
           let apURL = URL(string: apRaw),
           let apToken = plistString("HEALTH_INGEST_TOKEN_AP") {
            targets.append(IngestTarget(url: apURL, token: apToken))
        }

        return targets
    }

    /// Non-empty Info.plist string, or nil. (Empty strings come from an unfilled
    /// `$(VAR)` build-setting substitution when the gitignored xcconfig is absent.)
    private static func plistString(_ key: String) -> String? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !s.isEmpty else { return nil }
        return s
    }

    // MARK: - Anchor persistence (UserDefaults, keyed by type identifier)

    private func anchorKey(_ identifier: String) -> String { "healthkit.anchor.\(identifier)" }

    private func loadAnchor(for identifier: String) -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: anchorKey(identifier)) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ anchor: HKQueryAnchor, for identifier: String) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        UserDefaults.standard.set(data, forKey: anchorKey(identifier))
    }
}
