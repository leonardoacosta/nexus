// nexus-presence — headless macOS presence sensor LaunchAgent.
//
// Spec: openspec/changes/mac-presence-observer (capability context-aware-routing)
//
// A no-UI Swift executable run by launchd (RunAtLoad + KeepAlive, bootstrapped
// into the user's Aqua session gui/501 so CMIO camera/mic reads work). It owns
// a NexusShared.PresenceObserver and POSTs each sensed delta to the LOCAL
// agent's `POST /presence/report`. No Dock, no window — it senses 24/7
// independently of the nexus-mac dashboard app.
//
// The Aqua session is REQUIRED: CoreMediaIO's
// `kCMIODevicePropertyDeviceIsRunningSomewhere` only reflects real camera use
// inside the GUI session — the same gui/501 bridge the swift-deploy /
// ios-deploy agents use. launchd respawns this on crash (KeepAlive).

import Foundation
import NexusShared

// ── Resolve where to report ─────────────────────────────────────────
//
// The local agent owns the presence vector for THIS Mac, so the sensor always
// targets loopback (the agent binds loopback + Tailscale). We deliberately do
// NOT use NexusEndpoint.resolved here: that honours the dashboard's
// SettingsStore.dashboardEndpoint override (which may point at a remote peer
// for failover viewing) — but a Mac's presence must land in its OWN agent. An
// explicit NX_PRESENCE_ENDPOINT env can override for testing.
let baseURL: URL = {
    if let raw = ProcessInfo.processInfo.environment["NX_PRESENCE_ENDPOINT"],
       !raw.isEmpty,
       let url = URL(string: raw) {
        return url
    }
    return URL(string: "http://localhost:7400")!
}()

// Qualify the type: NexusShared.NexusClient. The legacy menu-bar target carries
// its own same-named `NexusClient`, so an unqualified reference is ambiguous in
// any target that links both. This executable only links NexusShared, but we
// keep the qualification per the documented footgun (SourceIndexView).
let client = NexusShared.NexusClient(endpoint: NexusShared.NexusEndpoint(baseURL: baseURL))

// Optional known-home gateway MAC fingerprint. When set, the observer compares
// the current default-route gateway MAC and reports `homeHint`. Permission-free.
let homeMAC = ProcessInfo.processInfo.environment["NX_HOME_GATEWAY_MAC"]

let observer = PresenceObserver(knownHomeGatewayMAC: homeMAC)

func log(_ message: String) {
    FileHandle.standardError.write(Data("nexus-presence: \(message)\n".utf8))
}

observer.onDelta = { delta in
    let body = delta.wireBody()
    guard !body.isEmpty else { return }
    // Fire-and-forget POST; the observer keeps sensing regardless of one
    // report's outcome (the next delta re-reports the full changed set).
    Task {
        let result = await client.reportPresence(body)
        if result == nil {
            log("report POST failed (agent down?) — fields: \(body.keys.sorted().joined(separator: ","))")
        } else {
            log("reported: \(body.keys.sorted().joined(separator: ","))")
        }
    }
}

log("starting presence observer (endpoint=\(baseURL.absoluteString), homeMAC=\(homeMAC ?? "none"))")
observer.start()

// Keep the process alive so the DistributedNotificationCenter lock observers +
// the sampling timer keep firing. dispatchMain() never returns (launchd owns
// the lifecycle; KeepAlive respawns on any exit).
dispatchMain()
