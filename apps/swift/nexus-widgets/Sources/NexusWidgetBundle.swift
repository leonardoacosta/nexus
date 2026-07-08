// NexusWidgetBundle — the WidgetKit extension entry point (@main) for the
// iOS queue-head widget (openspec/changes/add-queue-head-widget, task 1.1).
//
// A single-widget bundle: the queue-head glance. SwiftUI-lifecycle WidgetBundle
// (no NSExtensionPrincipalClass — the @main synthesizes the extension entry).

import WidgetKit
import SwiftUI

@main
struct NexusWidgetBundle: WidgetBundle {
    var body: some Widget {
        QueueHeadWidget()
    }
}
