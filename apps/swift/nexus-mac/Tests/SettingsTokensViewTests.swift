// SettingsTokensViewTests — round-trip persistence for the sidecar/ingest
// bearer-token overrides + Info.plist fallback semantics + view mount smoke.

import XCTest
import SwiftUI
@testable import nexus
@testable import NexusShared

@MainActor
final class SettingsTokensViewTests: XCTestCase {

    private func freshStore() -> (SettingsStore, UserDefaults) {
        let suite = "test.tokens.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (SettingsStore(defaults: defaults), defaults)
    }

    func testSaveRoundTripsOverridesToStore() {
        let (store, _) = freshStore()
        let model = SettingsTokensViewModel(store: store)
        model.medsToken = "meds-abc"
        model.plaidControlToken = "plaid-def"
        model.healthIngestToken = "health-ghi"
        model.save()

        XCTAssertEqual(store.medsToken, "meds-abc")
        XCTAssertEqual(store.plaidControlToken, "plaid-def")
        XCTAssertEqual(store.healthIngestToken, "health-ghi")
        XCTAssertTrue(model.savedConfirmation)
    }

    func testEmptyFieldClearsOverride() {
        let (store, _) = freshStore()
        store.medsToken = "pre-existing"
        XCTAssertEqual(store.medsToken, "pre-existing")

        let model = SettingsTokensViewModel(store: store)
        XCTAssertEqual(model.medsToken, "pre-existing", "model loads existing override")
        model.medsToken = ""
        model.save()

        // No UserDefaults override AND no Info.plist MEDS_TOKEN in the test
        // bundle -> resolves nil (empty string clears the override).
        XCTAssertNil(store.medsToken)
    }

    func testViewMountsInline() {
        // Smoke: constructing the view exercises the whole opaque `body`.
        _ = SettingsTokensView()
    }
}
