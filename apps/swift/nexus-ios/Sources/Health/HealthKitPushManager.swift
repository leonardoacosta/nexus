// HealthKitPushManager — reads Apple Health biometric samples and PUSHES them to
// the homelab mx-health ingest endpoint over the tailnet.
//
// This is the PRODUCTION producer for the mx mesh's src-health capability
// (mx repo: mx-sqd / mx-4d0). It replaces the Health Auto Export stopgap by
// reading HealthKit directly from inside the Nexus app — which is already on the
// phone and already on the tailnet — and POSTing the SAME JSON shape the homelab
// decoder (internal/health/ingest.go) accepts, so one decoder serves both
// producers.
//
// NOTE ON NAMING: this is APPLE BIOMETRIC HealthKit data (heart rate / HRV),
// distinct from the existing nexus "health" surface (HealthSummaryScene /
// HealthCollector = CPU/mem/disk SYSTEM metrics). Kept in its own `Health` group
// and prefixed HealthKit* to avoid that collision.
//
// DESIGN: cloned from ApnsRegistrar's actor + Info.plist-endpoint pattern.
//   - Reads resting HR / HR / HRV via HKAnchoredObjectQuery with a PERSISTED
//     anchor (UserDefaults), so each wake pushes only new samples, never a full
//     re-export.
//   - HKObserverQuery + enableBackgroundDelivery push-on-change while backgrounded.
//   - Endpoint resolves from Info.plist HEALTH_INGEST_ENDPOINT, default
//     http://homelab:8796/ingest. Optional HEALTH_INGEST_TOKEN -> Bearer.
//   - The anchor advances ONLY after a 2xx, so a failed push is retried next wake.
//
// Self-contained on purpose (Foundation + HealthKit only, no NexusShared/app-type
// dependency) so it drops in cleanly and type-checks in isolation.

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
        cfg.timeoutIntervalForRequest = 15
        cfg.timeoutIntervalForResource = 60
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    /// Health Auto Export's timestamp layout: "2026-06-07 06:05:00 -0500". POSIX
    /// locale + the `Z` token emit the numeric GMT offset that the Go decoder
    /// layout "2006-01-02 15:04:05 -0700" parses. Instance-isolated to the actor
    /// (DateFormatter is not reliably thread-safe across actors).
    private let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        return f
    }()

    /// One biometric metric: its HealthKit identifier plus how it maps onto the
    /// Health Auto Export export (name + unit), matching the homelab rules
    /// (resting_heart_rate drives the Slice-1 band signal).
    private struct Metric {
        let id: HKQuantityTypeIdentifier
        let exportName: String
        let unit: HKUnit
        let unitString: String
    }

    private let metrics: [Metric] = [
        Metric(id: .restingHeartRate,
               exportName: "resting_heart_rate",
               unit: HKUnit.count().unitDivided(by: .minute()),
               unitString: "count/min"),
        Metric(id: .heartRate,
               exportName: "heart_rate",
               unit: HKUnit.count().unitDivided(by: .minute()),
               unitString: "count/min"),
        Metric(id: .heartRateVariabilitySDNN,
               exportName: "heart_rate_variability",
               unit: HKUnit.secondUnit(with: .milli),
               unitString: "ms"),
    ]

    // MARK: - Lifecycle

    /// Bootstrap on app launch: request read auth, then for each metric register a
    /// background observer and do an initial anchored flush. Safe to call more than
    /// once (HealthKit only prompts for authorization once).
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
        for metric in metrics {
            registerObserver(for: metric)
            await flush(metric)
        }
    }

    /// Request READ authorization for the biometric types (we never write back —
    /// toShare is empty, matching the read-only mesh posture).
    func requestAuthorization() async throws {
        let readTypes = Set(metrics.compactMap { HKObjectType.quantityType(forIdentifier: $0.id) })
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    // MARK: - Observers + background delivery

    private func registerObserver(for metric: Metric) {
        guard let quantityType = HKObjectType.quantityType(forIdentifier: metric.id) else { return }

        let observer = HKObserverQuery(sampleType: quantityType, predicate: nil) { [weak self] _, completionHandler, error in
            guard let self else { completionHandler(); return }
            if let error {
                Task { await self.logObserverError(metric: metric, error: error) }
                completionHandler()
                return
            }
            // Flush, THEN call the background-delivery completion so the system
            // knows the wake was handled and keeps delivering.
            Task {
                await self.flush(metric)
                completionHandler()
            }
        }
        store.execute(observer)
        store.enableBackgroundDelivery(for: quantityType, frequency: .hourly) { [weak self] success, error in
            guard let self else { return }
            Task { await self.logBackgroundDelivery(metric: metric, success: success, error: error) }
        }
    }

    private func logObserverError(metric: Metric, error: Error) {
        log.error("observer error for \(metric.exportName, privacy: .public): \(error.localizedDescription, privacy: .public)")
    }

    private func logBackgroundDelivery(metric: Metric, success: Bool, error: Error?) {
        if let error {
            log.error("background delivery for \(metric.exportName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        } else {
            log.info("background delivery enabled for \(metric.exportName, privacy: .public): \(success)")
        }
    }

    // MARK: - Anchored fetch + push

    /// Fetch new samples since the persisted anchor, push them, and advance the
    /// anchor only on a successful (2xx) push so failures retry next wake.
    private func flush(_ metric: Metric) async {
        guard let quantityType = HKObjectType.quantityType(forIdentifier: metric.id) else { return }
        let anchor = loadAnchor(for: metric.id)
        let (samples, newAnchor) = await fetchSamples(type: quantityType, anchor: anchor)
        guard !samples.isEmpty else { return }
        let pushed = await push(metric: metric, samples: samples)
        if pushed, let newAnchor {
            saveAnchor(newAnchor, for: metric.id)
        }
    }

    private func fetchSamples(type: HKQuantityType, anchor: HKQueryAnchor?) async -> ([HKQuantitySample], HKQueryAnchor?) {
        await withCheckedContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: type,
                predicate: nil,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samplesOrNil, _, newAnchor, _ in
                let samples = (samplesOrNil as? [HKQuantitySample]) ?? []
                continuation.resume(returning: (samples, newAnchor))
            }
            store.execute(query)
        }
    }

    /// Build the Health Auto Export envelope for one metric's samples and POST it.
    /// Returns true on a 2xx response.
    private func push(metric: Metric, samples: [HKQuantitySample]) async -> Bool {
        let data: [[String: Any]] = samples.map { sample in
            [
                "date": dateFormatter.string(from: sample.endDate),
                "qty": sample.quantity.doubleValue(for: metric.unit),
                "source": sample.sourceRevision.source.name,
            ]
        }
        let envelope: [String: Any] = [
            "data": [
                "metrics": [
                    [
                        "name": metric.exportName,
                        "units": metric.unitString,
                        "data": data,
                    ]
                ]
            ]
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: envelope) else {
            log.error("failed to encode \(metric.exportName, privacy: .public) envelope")
            return false
        }

        var request = URLRequest(url: Self.ingestURL())
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = Self.ingestToken() {
            request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body

        do {
            let (_, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200...299).contains(code) {
                log.info("pushed \(samples.count) \(metric.exportName, privacy: .public) sample(s)")
                return true
            }
            log.error("ingest returned \(code) for \(metric.exportName, privacy: .public)")
            return false
        } catch {
            log.error("ingest POST failed for \(metric.exportName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    // MARK: - Endpoint resolution (Info.plist, homelab fallback)

    private static func ingestURL() -> URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "HEALTH_INGEST_ENDPOINT") as? String,
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "http://homelab:8796/ingest")!
    }

    private static func ingestToken() -> String? {
        guard let token = Bundle.main.object(forInfoDictionaryKey: "HEALTH_INGEST_TOKEN") as? String,
              !token.isEmpty else {
            return nil
        }
        return token
    }

    // MARK: - Anchor persistence (UserDefaults)

    private func anchorKey(_ id: HKQuantityTypeIdentifier) -> String {
        "healthkit.anchor.\(id.rawValue)"
    }

    private func loadAnchor(for id: HKQuantityTypeIdentifier) -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: anchorKey(id)) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ anchor: HKQueryAnchor, for id: HKQuantityTypeIdentifier) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        UserDefaults.standard.set(data, forKey: anchorKey(id))
    }
}
