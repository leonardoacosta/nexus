// SystemSpeechSynthesizer — thin `/usr/bin/say` subprocess wrapper used as
// the fallback synthesis path when ElevenLabs is unavailable.
//
// Spec: openspec/changes/mac-tts-runtime-wire-up (task 1.1)
// Updated (nx-4fgao): swapped AVSpeechSynthesizer for /usr/bin/say to get
// the System Settings -> Accessibility -> Spoken Content system voice
// (typically a premium Siri/Ava/Samantha Enhanced variant) instead of
// AVSpeechSynthesizer's dated compact default voice.
//
// NOT a singleton. Each call spawns a short-lived `/usr/bin/say` process
// fire-and-forget. The OS coalesces audio routing.
//
// Platform: `/usr/bin/say` is macOS-only. The legacy AVFoundation path
// supported iOS/watchOS, but TTSObserver only invokes this synth on macOS,
// so dropping cross-platform support is acceptable.

import Foundation
import os.log

@MainActor
public final class SystemSpeechSynthesizer {
    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "SystemSpeechSynthesizer"
    )

    public init() {}

    /// Speak text via the system `say` command. Uses the system default voice
    /// configured in System Settings -> Accessibility -> Spoken Content.
    /// Higher quality than AVSpeechSynthesizer's default compact voice.
    /// Rate is in words per minute (170-200 sounds natural; macOS default
    /// ~175). Fire-and-forget — does NOT block on the subprocess.
    public func speak(_ text: String, rate: Int = 175) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let task = Process()
        task.launchPath = "/usr/bin/say"
        task.arguments = ["-r", String(rate), trimmed]

        Self.logger.info("SystemSpeechSynthesizer: say invoked rate=\(rate) text_len=\(trimmed.count)")

        do {
            try task.run()
            // Fire-and-forget: do NOT call task.waitUntilExit().
        } catch {
            Self.logger.error("SystemSpeechSynthesizer: say failed error=\(error.localizedDescription, privacy: .public)")
        }
    }
}
