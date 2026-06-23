// HealthKitMedBridge — reads Apple Health's MEDICATION data (the user's med
// list + their logged dose events) and PUSHES it to BOTH the mx meds-ingest
// sidecar (homelab tailnet) AND Apothecary (ap, HTTPS) using PER-TARGET
// anchors so a down mx never blocks ap and vice-versa.
//
// Capability: src-meds (mx-t66o). Beads: mx-aw88 / nx-ktyo9.
// The meds-ingest routes live on the SAME homelab :8802 server as the meds
// CRUD sidecar (see NexusShared/Networking/NexusClient+Meds.swift
// `medsBaseURL()`), so this bridge derives its base URL the same way.
//
// DUAL-PUSH SEMANTICS (PER-TARGET ANCHORS) — mirrors HealthKitPushManager:
//   - The DOSE ANCHOR is per-target: "healthkit.meds.anchor.doseEvents.<key>"
//     ("mx" / "ap"). Each target's anchor advances ONLY on that target's 2xx.
//     A down mx does not block ap; a down ap does not block mx.
//   - The MED CATALOG is a full re-push every bootstrap (HKUserAnnotatedMedication-
//     Query is not an anchored query — it has no anchor type). ap and mx both
//     upsert idempotently by hk_med_id, so re-pushing is safe.
//
// ARCHITECTURE: mirrors HealthKitPushManager (the biometric producer, mx-4d0):
//   - requests HealthKit auth,
//   - runs an HKAnchoredObjectQuery over HKMedicationDoseEvent + registers an
//     HKObserverQuery with background delivery (event-driven background wakes),
//   - encodes + chunks + POSTs a JSON envelope to the ingest,
//   - persists the anchor in UserDefaults, advancing ONLY on a 2xx.
// It additionally runs a one-shot HKUserAnnotatedMedicationQuery (NOT an
// anchored query — that type is not an HKSample) to push the med catalog.
//
// iOS 26 ONLY. HKMedicationDoseEvent / HKUserAnnotatedMedication are
// API_AVAILABLE(ios(26.0)). The whole bridge is gated behind `if #available
// (iOS 26.0, *)`; on older OSes it no-ops cleanly (mirroring the producer's
// isHealthDataAvailable guard).
//
// ──────────────────────────────────────────────────────────────────────────
// READ-ONLY by SDK design (the mx-aw88 design's open question, RESOLVED):
//
// The iOS 26.4 SDK exposes NO write path for medications. Both
// HKMedicationDoseEvent AND HKUserAnnotatedMedication declare
// `- (instancetype)init NS_UNAVAILABLE;` and there is no builder, factory, or
// `+save…` API anywhere in HealthKit.framework/Headers (verified against
// iPhoneOS26.4.sdk). A third-party app can therefore:
//   - READ the user's annotated med list (push to mx/ap),  ✅
//   - READ logged dose events (push to mx/ap),             ✅
//   - CREATE an HKUserAnnotatedMedication,                 ❌ (no initializer)
//   - WRITE / save an HKMedicationDoseEvent back to HK,    ❌ (no initializer).
//
// So the "two-way save" the design hoped for is NOT possible on iOS 26.4: the
// Health app is the sole writer of medication data. nx-created meds (via the
// add-med form) stay mx-local; only Apple-Health-defined meds + their
// Health-app-logged doses round-trip INTO mx/ap. `saveDoseEvents(forGroup:)`
// below is the wiring seam kept for the take-group path, but it is an
// intentional no-op that logs the limitation rather than inventing a
// non-existent symbol. If Apple ships a dose-event write API in a later SDK,
// fill in `saveDoseEvents` and call the HKHealthStore.save path there.
// ──────────────────────────────────────────────────────────────────────────
//
// Depends on NexusShared for the meds base-URL derivation (NexusClient.
// medsBaseURL) + the meds-token knob (SettingsStore) — the SAME homelab :8802
// host the meds CRUD sidecar uses. HealthKit + Foundation otherwise.

import Foundation
import HealthKit
import NexusShared
import os.log

@available(iOS 26.0, *)
actor HealthKitMedBridge {
    static let shared = HealthKitMedBridge()

    private let store = HKHealthStore()
    private let log = Logger(subsystem: "dev.leonardoacosta.nexus.ios", category: "healthkit-meds")

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 120
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    /// RFC3339 with the numeric GMT offset (matches the mx ingest's logged_at /
    /// scheduled_at parsing, and the rfc3339 helper in NexusClient+Meds).
    private let rfc3339: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// RxNorm coding system URL — `relatedCodings` entries with this `system`
    /// carry the numeric RxNorm `code` mx reconciles on.
    private static let rxnormSystem = "http://www.nlm.nih.gov/research/umls/rxnorm"

    /// Guards one-time observer registration per PROCESS (mirrors the producer).
    private var observerRegistered = false

    // MARK: - Ingest targets (mirrors HealthKitPushManager.IngestTarget)

    /// One meds-ingest destination: a base URL + bearer token + stable key.
    /// `key` is used as the per-target dose-anchor suffix ("mx" / "ap").
    private struct MedIngestTarget {
        let baseURL: URL
        let token: String?
        let key: String

        static let mxKey = "mx"
        static let apKey = "ap"
    }

    /// Resolve the full list of meds-ingest targets:
    ///   - mx homelab: NexusClient.medsBaseURL() + SettingsStore.medsToken
    ///     (always present; falls back to http://homelab:8802).
    ///   - Apothecary: https://apothecary.leonardoacosta.dev/api/health/ +
    ///     HEALTH_INGEST_TOKEN_AP (additive; added only when a non-empty token
    ///     is present in Info.plist so a build without Secrets.xcconfig
    ///     degrades to mx-only rather than POSTing unauthenticated).
    private static func ingestTargets() -> [MedIngestTarget] {
        var targets: [MedIngestTarget] = []

        // mx homelab (existing behaviour).
        let mxBase = NexusClient.medsBaseURL()
        targets.append(MedIngestTarget(
            baseURL: mxBase,
            token: SettingsStore.shared.medsToken.flatMap { $0.isEmpty ? nil : $0 },
            key: MedIngestTarget.mxKey
        ))

        // Apothecary — reuse the SAME HEALTH_INGEST_TOKEN_AP knob that the
        // biometric push manager uses (mirrors HealthKitPushManager.ingestTargets).
        if let apToken = plistString("HEALTH_INGEST_TOKEN_AP"),
           let apBase = URL(string: "https://apothecary.leonardoacosta.dev/api/health/") {
            targets.append(MedIngestTarget(
                baseURL: apBase,
                token: apToken,
                key: MedIngestTarget.apKey
            ))
        }

        return targets
    }

    /// Non-empty Info.plist string, or nil.
    private static func plistString(_ key: String) -> String? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !s.isEmpty else { return nil }
        return s
    }

    // MARK: - Lifecycle

    /// Bootstrap on app launch: request auth, push the med catalog, register a
    /// background observer for dose events, then do an initial anchored flush.
    /// Safe to call repeatedly.
    func bootstrap() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            log.info("HealthKit unavailable; med bridge disabled")
            return
        }
        guard let doseType = Self.doseEventType else {
            log.info("HKMedicationDoseEvent type unavailable at runtime; med bridge disabled")
            return
        }
        // Request PER-OBJECT medication read consent (mx-rkir.10 root-cause fix).
        // Medication types are per-object auth types — they must NOT be routed
        // through store.requestAuthorization(read:) (that throws an uncatchable
        // NSInvalidArgumentException). Without this prompt the queries below
        // return empty WITHOUT consent, so nothing imports. See
        // requestAuthorization() for the full rationale. try? — never crash boot.
        try? await requestAuthorization()
        await pushMedicationCatalog()
        if !observerRegistered {
            registerDoseObserver(doseType)
            observerRegistered = true
        }
        await flushDoseEvents()
    }

    /// flushAll — shared entry point for the BACKGROUND triggers (BGTaskScheduler
    /// + silent APNS), mirroring HealthKitPushManager.flushAll. Refreshes the med
    /// catalog (cheap, idempotent on both targets) then flushes new dose events.
    /// Does NOT register observers (that is bootstrap's once-per-process job).
    func flushAll() async {
        guard HKHealthStore.isHealthDataAvailable(), Self.doseEventType != nil else { return }
        await pushMedicationCatalog()
        await flushDoseEvents()
    }

    // MARK: - Type resolution (iOS 26 SDK)

    /// HKMedicationDoseEvent sample type (an HKSampleType, anchored-queryable).
    private static var doseEventType: HKSampleType? {
        HKObjectType.medicationDoseEventType()
    }

    /// HKUserAnnotatedMedication authorizeable type (an HKObjectType, ios26+),
    /// distinct from the dose-event SAMPLE type — it has its own non-anchored
    /// HKUserAnnotatedMedicationQuery.
    private static var annotatedMedType: HKObjectType {
        HKObjectType.userAnnotatedMedicationType()
    }

    /// Request READ consent for the ANNOTATED-MEDICATION type via per-object auth.
    ///
    /// The two medication types authorize DIFFERENTLY, and getting this wrong
    /// throws an UNCATCHABLE ObjC `NSInvalidArgumentException` (signal 6) — Swift
    /// `do/catch` does NOT trap it, so a wrong call crashes the app on launch:
    ///
    ///   • `HKUserAnnotatedMedicationType` (a bare `HKObjectType`) is a PER-OBJECT
    ///     auth type (like vision prescriptions). `requestPerObjectReadAuthorization`
    ///     displays the sheet and works. This is what surfaces the med catalog and
    ///     is the ONLY type we need consent for to import `/meds/medications`.
    ///
    ///   • `HKMedicationDoseEventType` (an `HKSampleType`) is NOT a per-object type
    ///     AND was rejected by standard `requestAuthorization(read:)` too. Calling
    ///     EITHER auth API for it throws: device-captured
    ///     "Per-Object authorization to read HKMedicationDoseEventType… is
    ///     disallowed" (mx-rkir.10 follow-up crash). So we request NO explicit auth
    ///     for the dose type — the anchored dose query reads whatever the granted
    ///     annotated-medication consent exposes (dose events are linked to the
    ///     consented medications).
    ///
    /// NO `com.apple.developer.healthkit.access` entitlement is required (that key
    /// gates FHIR `health-records` only). Per Apple per-object auth re-prompts on
    /// every call, so we gate to ONCE per install via a UserDefaults flag.
    ///
    /// IMPORTANT: this method is `nonisolated` and runs the throwing per-object call
    /// directly — DO NOT add the dose type back here; that re-introduces the crash.
    func requestAuthorization() async throws {
        guard !UserDefaults.standard.bool(forKey: Self.medAuthRequestedKey) else { return }
        // ONLY the per-object annotated-medication type. The dose type is
        // intentionally omitted (it crashes on either auth API — see doc above).
        try await store.requestPerObjectReadAuthorization(
            for: Self.annotatedMedType, predicate: nil)
        UserDefaults.standard.set(true, forKey: Self.medAuthRequestedKey)
        log.info("requested per-object annotated-medication read authorization")
    }

    private static let medAuthRequestedKey = "healthkit.meds.perObjectAuthRequested"

    // MARK: - Medication catalog (HKUserAnnotatedMedicationQuery, one-shot)

    /// Query the user's annotated med list and POST each to
    /// `<target>/meds/ingest/medications` for EVERY resolved target.
    /// mx and ap both upsert idempotently by hk_med_id, so re-pushing is safe.
    private func pushMedicationCatalog() async {
        let meds = await fetchAnnotatedMedications()
        guard !meds.isEmpty else { return }
        let payload: [[String: Any]] = meds.map { $0.ingestPayload }

        let targets = Self.ingestTargets()
        for target in targets {
            let ok = await postMedications(payload, to: target)
            if ok {
                log.info("pushed \(payload.count) annotated medication(s) -> \(target.key, privacy: .public)")
            } else {
                log.error("medication catalog push failed -> \(target.key, privacy: .public)")
            }
        }
    }

    /// One element of the `/meds/ingest/medications` body, decoded off an
    /// annotated med + its concept.
    private struct AnnotatedMed {
        let hkMedID: String
        let name: String
        let rxnorm: String?

        var ingestPayload: [String: Any] {
            var d: [String: Any] = ["hk_med_id": hkMedID, "name": name]
            if let rxnorm { d["rxnorm"] = rxnorm }
            // dose/unit are not surfaced on HKMedicationConcept (only generalForm
            // + codings); mx and ap treat them as optional, so we omit them here.
            return d
        }
    }

    private func fetchAnnotatedMedications() async -> [AnnotatedMed] {
        await withCheckedContinuation { continuation in
            var collected: [AnnotatedMed] = []
            let query = HKUserAnnotatedMedicationQuery(
                predicate: nil,
                limit: HKObjectQueryNoLimit
            ) { _, medOrNil, done, _ in
                if let med = medOrNil {
                    let concept = med.medication
                    // Prefer the user's nickname; fall back to the concept's
                    // display text. hk_med_id is the stable cross-device concept
                    // identity (archived as a base64 key — see stableKey).
                    let name = med.nickname?.isEmpty == false
                        ? med.nickname!
                        : concept.displayText
                    collected.append(AnnotatedMed(
                        hkMedID: Self.stableKey(for: concept.identifier),
                        name: name,
                        rxnorm: Self.rxnorm(from: concept.relatedCodings)
                    ))
                }
                if done {
                    continuation.resume(returning: collected)
                }
            }
            store.execute(query)
        }
    }

    // MARK: - Dose events (HKAnchoredObjectQuery + observer)

    /// Register the background observer + enable hourly background delivery for
    /// dose events (mirrors HealthKitPushManager.registerObserver).
    private func registerDoseObserver(_ type: HKSampleType) {
        let observer = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completionHandler, error in
            guard let self else { completionHandler(); return }
            if let error {
                Task { await self.logObserverError(error) }
                completionHandler()
                return
            }
            Task {
                await self.flushDoseEvents()
                completionHandler()
            }
        }
        store.execute(observer)
        store.enableBackgroundDelivery(for: type, frequency: .hourly) { [weak self] success, error in
            guard let self else { return }
            Task { await self.logBackgroundDelivery(success: success, error: error) }
        }
    }

    /// Flush dose events to ALL resolved ingest targets with PER-TARGET anchors.
    /// Each target fetches from its own stored anchor and advances it only on
    /// that target's 2xx — mirrors HealthKitPushManager.flush / flushToTarget.
    private func flushDoseEvents() async {
        guard let type = Self.doseEventType else { return }
        let targets = Self.ingestTargets()
        for target in targets {
            await flushDosesToTarget(type: type, target: target)
        }
    }

    /// Fetch dose events newer than THIS TARGET's anchor, push to that target,
    /// advance only that target's anchor on 2xx. A failure leaves the anchor
    /// unmoved so the target retries from the same position on the next wake.
    private func flushDosesToTarget(type: HKSampleType, target: MedIngestTarget) async {
        let anchor = loadDoseAnchor(targetKey: target.key)
        let (samples, newAnchor) = await fetchDoseSamples(type: type, anchor: anchor)
        guard !samples.isEmpty else { return }
        let payload = samples.compactMap { Self.dosePayload(from: $0, rfc3339: rfc3339) }
        guard !payload.isEmpty else {
            // Nothing extractable (e.g. NotInteracted slots filtered out) — still
            // advance so we don't re-scan them every wake.
            if let newAnchor { saveDoseAnchor(newAnchor, targetKey: target.key) }
            return
        }
        if await postDoses(payload, to: target), let newAnchor {
            saveDoseAnchor(newAnchor, targetKey: target.key)
            log.info("pushed \(payload.count) dose event(s) -> \(target.key, privacy: .public)")
        }
    }

    private func fetchDoseSamples(type: HKSampleType, anchor: HKQueryAnchor?) async -> ([HKMedicationDoseEvent], HKQueryAnchor?) {
        await withCheckedContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: type,
                predicate: nil,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samplesOrNil, _, newAnchor, _ in
                let doses = (samplesOrNil ?? []).compactMap { $0 as? HKMedicationDoseEvent }
                continuation.resume(returning: (doses, newAnchor))
            }
            store.execute(query)
        }
    }

    /// Map an HKMedicationDoseEvent to a `/meds/ingest/doses` body element.
    /// Returns nil for non-take/skip statuses (NotInteracted / NotLogged /
    /// Snoozed / NotificationNotSent) — mx and ap only track taken|skipped.
    static func dosePayload(from dose: HKMedicationDoseEvent, rfc3339: ISO8601DateFormatter) -> [String: Any]? {
        let status: String
        switch dose.logStatus {
        case .taken: status = "taken"
        case .skipped: status = "skipped"
        default: return nil // NotInteracted / Snoozed / NotificationNotSent / NotLogged
        }

        // doseQuantity is NS_REFINED_FOR_SWIFT (NSNumber? -> Double?). Fall back to
        // the scheduled quantity when the as-taken amount is absent.
        let qty = dose.doseQuantity ?? dose.scheduledDoseQuantity
        let unit = dose.unit.unitString

        var d: [String: Any] = [
            "hk_dose_uuid": dose.uuid.uuidString,
            "hk_med_id": stableKey(for: dose.medicationConceptIdentifier),
            "status": status,
            "dose": qty.map { Self.trimmed($0) } ?? "",
            "unit": unit,
            // endDate is the moment the dose was logged/taken (HKSample timeline).
            "logged_at": rfc3339.string(from: dose.endDate),
        ]
        // scheduledDate is non-null only for scheduled (vs as-needed) doses.
        if let scheduled = dose.scheduledDate {
            d["scheduled_at"] = rfc3339.string(from: scheduled)
        }
        return d
    }

    /// Render a dose quantity without a trailing ".0" for whole numbers
    /// ("2.0" -> "2", "0.5" -> "0.5"), matching how nx stores `dose` strings.
    static func trimmed(_ value: Double) -> String {
        if value == value.rounded() { return String(Int(value)) }
        return String(value)
    }

    // MARK: - Stable cross-device key for a concept identifier

    /// HKHealthConceptIdentifier exposes only `domain` publicly — no string/UUID
    /// accessor. It IS NSSecureCoding, and the docs guarantee the identifier is
    /// "stable across devices", so we archive it and base64-encode the bytes for
    /// a deterministic, comparable key. mx and ap treat hk_med_id as an opaque
    /// stable string (mx dedups doses by hk_dose_uuid and recons meds by
    /// hk_med_id + rxnorm; ap upserts by hk_med_id), so an opaque base64 key is
    /// sufficient and consistent between the med-catalog push (concept.identifier)
    /// and the dose push (dose.medicationConceptIdentifier) for the SAME medication.
    static func stableKey(for identifier: HKHealthConceptIdentifier) -> String {
        if let data = try? NSKeyedArchiver.archivedData(withRootObject: identifier, requiringSecureCoding: true) {
            return data.base64EncodedString()
        }
        // Fallback: domain (lossy, but never crashes). In practice the archive
        // path always succeeds for an NSSecureCoding type.
        return identifier.domain.rawValue
    }

    // MARK: - Two-way save (wiring seam — NO-OP on iOS 26.4)

    /// Take-group hook: AFTER the mx sidecar `takeGroup` succeeds, the caller
    /// (MedsObserver.takeGroup) invokes this so Apple Health's adherence/refill/
    /// interaction tracking would stay consistent. On iOS 26.4 this is an
    /// intentional NO-OP: there is no public initializer or save API for
    /// HKMedicationDoseEvent (the Health app is the sole writer of medication
    /// data — verified against iPhoneOS26.4.sdk). Only members that map to an
    /// HKUserAnnotatedMedication (have a non-empty hk_med_id) would be eligible
    /// for a HK write if Apple ever ships one; nx-local-only meds are skipped.
    ///
    /// Kept as a real method so the call site is wired and ready: when a write
    /// API lands, construct + `store.save(…)` the "taken" dose events here, using
    /// the same hk_dose_uuid logic so a later re-import dedups (no double count).
    func saveDoseEvents(forGroup members: [MedicationWriteMember]) async {
        let eligible = members.filter { !($0.hkMedID ?? "").isEmpty }
        guard !eligible.isEmpty else { return }
        log.info("""
            HK dose-event write requested for \(eligible.count, privacy: .public) member(s) but \
            iOS 26.4 exposes no HKMedicationDoseEvent write API; skipping HK write \
            (the mx sidecar take already succeeded).
            """)
        // No store.save — see method/file header. Intentionally inert.
    }

    /// Minimal value type for the take-group write hook so the bridge stays
    /// self-contained (no dependency on NexusShared's MedGroupMember). `hkMedID`
    /// is the Medication.hkMedId surfaced by the mx side (nil for nx-local meds).
    struct MedicationWriteMember: Sendable {
        let medID: String
        let hkMedID: String?
        let dose: String
        init(medID: String, hkMedID: String?, dose: String) {
            self.medID = medID
            self.hkMedID = hkMedID
            self.dose = dose
        }
    }

    // MARK: - Codings

    /// Extract the numeric RxNorm code from a concept's clinical codings.
    static func rxnorm(from codings: Set<HKClinicalCoding>) -> String? {
        codings.first { $0.system == rxnormSystem }?.code
    }

    // MARK: - Ingest POSTs (per-target)

    /// POST `[{...}]` to `<target>/meds/ingest/medications`. Returns true on 2xx.
    private func postMedications(_ body: [[String: Any]], to target: MedIngestTarget) async -> Bool {
        await postArray(path: "meds/ingest/medications", body: body, target: target)
    }

    /// POST `[{...}]` to `<target>/meds/ingest/doses`. Returns true on 2xx.
    private func postDoses(_ body: [[String: Any]], to target: MedIngestTarget) async -> Bool {
        await postArray(path: "meds/ingest/doses", body: body, target: target)
    }

    private func postArray(path: String, body: [[String: Any]], target: MedIngestTarget) async -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else {
            log.error("failed to encode \(path, privacy: .public) body for \(target.key, privacy: .public)")
            return false
        }
        var request = URLRequest(url: target.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.addValue("application/json", forHTTPHeaderField: "Accept")
        if let token = target.token {
            request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = data
        let host = target.baseURL.host ?? target.baseURL.absoluteString
        do {
            let (_, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200...299).contains(code) { return true }
            log.error("\(path, privacy: .public) ingest \(host, privacy: .public) [\(target.key, privacy: .public)] returned \(code)")
            return false
        } catch {
            log.error("\(path, privacy: .public) ingest \(host, privacy: .public) [\(target.key, privacy: .public)] POST failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    // MARK: - Dose anchor persistence (per-target, UserDefaults)
    //
    // Anchor key scheme: "healthkit.meds.anchor.doseEvents.<targetKey>"
    // ("mx" / "ap"). The legacy single-target scheme used the bare key
    // "healthkit.meds.anchor.doseEvents" — that key is not removed here to
    // avoid a re-push of the full history on first upgrade; per-target keys
    // shadow it and the legacy key is effectively orphaned after the first flush.

    private static let doseAnchorKeyPrefix = "healthkit.meds.anchor.doseEvents"

    private func doseAnchorKey(targetKey: String) -> String {
        "\(Self.doseAnchorKeyPrefix).\(targetKey)"
    }

    private func loadDoseAnchor(targetKey: String) -> HKQueryAnchor? {
        let key = doseAnchorKey(targetKey: targetKey)
        // Prefer the per-target key; fall back to the legacy bare key on first
        // run so mx doesn't re-push the full dose history after the upgrade.
        let data = UserDefaults.standard.data(forKey: key)
            ?? (targetKey == MedIngestTarget.mxKey
                ? UserDefaults.standard.data(forKey: Self.doseAnchorKeyPrefix)
                : nil)
        guard let data else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveDoseAnchor(_ anchor: HKQueryAnchor, targetKey: String) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        UserDefaults.standard.set(data, forKey: doseAnchorKey(targetKey: targetKey))
    }

    // MARK: - Logging helpers (off the query callbacks)

    private func logObserverError(_ error: Error) {
        log.error("dose observer error: \(error.localizedDescription, privacy: .public)")
    }

    private func logBackgroundDelivery(success: Bool, error: Error?) {
        if let error {
            log.error("dose background delivery failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
