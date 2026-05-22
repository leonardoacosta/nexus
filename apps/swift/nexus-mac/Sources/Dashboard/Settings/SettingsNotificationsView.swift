// SettingsNotificationsView — banner + sort/group/replay defaults for the
// notifications surface.
//
// Spec: openspec/changes/settings-tab-redesign (task 2.4, bd:nx-mu14j)
//
// All keys are @AppStorage-backed under the `notifications.*` namespace.
// Existing keys (`notifications.sort`, `notifications.group`) are reused
// verbatim so the redesign does not reset user preferences set by the
// NotificationsView toolbar.

import SwiftUI
import NexusShared

struct SettingsNotificationsView: View {
    /// Mirrors NotificationsView toolbar key — banner is a cross-section
    /// override that also surfaces in SettingsTtsView's toggles block. The
    /// two views read/write the same key so changing one updates the other.
    @AppStorage(SettingsTtsKeys.banner) private var bannerEnabled: Bool = true

    /// Default sort mode for the notification history list. Reuses the
    /// `notifications.sort` key first introduced by notifications-overhaul.
    @AppStorage("notifications.sort")
    private var sortRaw: String = NotificationSortMode.time.rawValue

    /// Default group-by toggle for the notification history list.
    @AppStorage("notifications.group") private var groupOn: Bool = false

    /// Replay autoplay — when ON, clicking a notification row plays back
    /// the cached MP3 automatically. New key in this spec.
    @AppStorage("notifications.replay.autoplay")
    private var replayAutoplay: Bool = false

    private var sortMode: Binding<NotificationSortMode> {
        Binding(
            get: { NotificationSortMode(rawValue: sortRaw) ?? .time },
            set: { sortRaw = $0.rawValue }
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Notifications").font(.title3).bold()

                VStack(alignment: .leading, spacing: 10) {
                    Toggle("Show notification banner", isOn: $bannerEnabled)
                    Text("Mirrors the toggle in TTS & Audio. The banner is the visible half of the TTS pipeline.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Divider()

                VStack(alignment: .leading, spacing: 10) {
                    Picker("Default sort", selection: sortMode) {
                        ForEach(NotificationSortMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    Toggle("Group by project by default", isOn: $groupOn)
                    Toggle("Autoplay replay on row click", isOn: $replayAutoplay)
                }

                Spacer(minLength: 12)
            }
            .padding(20)
        }
    }
}
