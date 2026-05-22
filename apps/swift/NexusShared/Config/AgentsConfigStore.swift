// AgentsConfigStore — read/write/validate ~/.config/nexus/agents.toml.
//
// Spec: openspec/changes/settings-tab-redesign (task 1.1, bd:nx-af3aq)
//
// AgentRegistry already hand-parses the file (read-only). This store
// reuses that parse via `AgentRegistry.parse(_:)` so Registry and Store
// share one code path. The new surface adds:
//   - `read() -> [AgentEntry]` — typed array (mirrors AgentDescriptor)
//   - `write(_:)` — atomic `.tmp + rename` write of array-of-tables
//   - `validate(_:)` — per-row checks (non-empty name, parseable URL)
//   - `readRaw()` / `writeRaw(_:)` — raw-text fallback for the SettingsAgentsView
//     raw editor when structured parse fails.
//
// Schema in array-of-tables form (matches what AgentRegistry consumes):
//
//     [[agents]]
//     name = "homelab"
//     host = "100.73.182.4"
//     port = 7400
//     user = "nyaptor"
//
// `endpoint = "http://host:port"` and `machine = "name"` from the
// settings-tab-redesign proposal map onto host+port and name respectively;
// we keep host/port on disk so AgentRegistry stays the single parser.

import Foundation

public enum AgentsConfigError: Error, Equatable {
    case parseFailure(String)
    case writeFailure(String)
    case ioFailure(String)
}

public struct AgentEntry: Sendable, Equatable, Identifiable {
    /// Stable id — name is unique-per-row by convention; SettingsAgentsView
    /// also keeps a UUID per row for SwiftUI list identity during edits.
    public var id: UUID
    public var name: String
    public var host: String
    public var port: Int
    public var user: String?

    public init(
        id: UUID = UUID(),
        name: String,
        host: String,
        port: Int,
        user: String? = nil
    ) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
        self.user = user
    }

    /// Convenience: `http://host:port`. The Mac UI surfaces this as the
    /// "endpoint" column even though we persist host/port separately.
    public var endpoint: String {
        "http://\(host):\(port)"
    }
}

public struct AgentValidationError: Equatable, Sendable {
    public enum Field: String, Sendable {
        case name
        case host
        case port
        case endpoint
    }

    public let field: Field
    public let message: String

    public init(field: Field, message: String) {
        self.field = field
        self.message = message
    }
}

public enum AgentsConfigStore {
    /// Default path: ~/.config/nexus/agents.toml. Matches AgentRegistry.
    public static var defaultPath: URL {
        AgentRegistry.defaultPath
    }

    /// Read + parse the structured agents.toml. Throws `.parseFailure` when
    /// the file exists but every reasonable parse strategy returns zero
    /// entries, signalling the raw fallback editor should engage. Returns
    /// `[]` (no throw) when the file is missing — a fresh-install operator
    /// should see an empty editor, not a parse error.
    public static func read(path: URL? = nil) throws -> [AgentEntry] {
        let url = path ?? defaultPath
        guard FileManager.default.fileExists(atPath: url.path) else {
            return []
        }
        let raw: String
        do {
            raw = try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw AgentsConfigError.ioFailure("could not read \(url.path): \(error)")
        }
        // Distinguish "empty file" from "parse failure". A file that
        // contains content but yields zero agents AND contains the
        // [[agents]] header is malformed; surface that to the raw editor.
        let descriptors = AgentRegistry.parse(raw)
        if descriptors.isEmpty {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && trimmed.contains("[[agents]]") {
                throw AgentsConfigError.parseFailure(
                    "agents.toml contains [[agents]] but no parseable entries"
                )
            }
            return []
        }
        return descriptors.map {
            AgentEntry(name: $0.name, host: $0.host, port: $0.port, user: $0.user)
        }
    }

    /// Atomic write — emit to `.tmp` then rename onto `defaultPath`. Mirrors
    /// the `.tmp + rename` idiom used by `/triage` frontmatter writes.
    public static func write(
        _ entries: [AgentEntry],
        path: URL? = nil
    ) throws {
        let url = path ?? defaultPath
        let tmp = url.deletingLastPathComponent()
            .appendingPathComponent(url.lastPathComponent + ".tmp")
        // Ensure the parent dir exists (~/.config/nexus may be fresh).
        let parent = url.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: parent.path) {
            try? FileManager.default.createDirectory(
                at: parent,
                withIntermediateDirectories: true
            )
        }
        let serialized = serialize(entries)
        do {
            try serialized.data(using: .utf8)?.write(to: tmp, options: .atomic)
        } catch {
            throw AgentsConfigError.writeFailure("tmp write failed: \(error)")
        }
        do {
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: url)
            }
        } catch {
            throw AgentsConfigError.writeFailure("rename failed: \(error)")
        }
    }

    /// Raw read for the fallback editor — never throws on parse, only on IO.
    /// Empty string when the file does not yet exist.
    public static func readRaw(path: URL? = nil) -> String {
        let url = path ?? defaultPath
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    /// Raw write — atomic, verbatim. Used by SettingsAgentsView's raw editor.
    public static func writeRaw(_ contents: String, path: URL? = nil) throws {
        let url = path ?? defaultPath
        let tmp = url.deletingLastPathComponent()
            .appendingPathComponent(url.lastPathComponent + ".tmp")
        let parent = url.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: parent.path) {
            try? FileManager.default.createDirectory(
                at: parent,
                withIntermediateDirectories: true
            )
        }
        do {
            try contents.data(using: .utf8)?.write(to: tmp, options: .atomic)
        } catch {
            throw AgentsConfigError.writeFailure("raw tmp write failed: \(error)")
        }
        do {
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: url)
            }
        } catch {
            throw AgentsConfigError.writeFailure("raw rename failed: \(error)")
        }
    }

    /// Per-row validation. Returns the empty array on a clean row; the
    /// SettingsAgentsView Save button stays disabled while non-empty.
    public static func validate(_ entry: AgentEntry) -> [AgentValidationError] {
        var errors: [AgentValidationError] = []
        let trimmedName = entry.name.trimmingCharacters(in: .whitespaces)
        if trimmedName.isEmpty {
            errors.append(.init(field: .name, message: "name must not be empty"))
        }
        let trimmedHost = entry.host.trimmingCharacters(in: .whitespaces)
        if trimmedHost.isEmpty {
            errors.append(.init(field: .host, message: "host must not be empty"))
        }
        if entry.port <= 0 || entry.port > 65535 {
            errors.append(.init(field: .port, message: "port must be 1-65535"))
        }
        // Endpoint synthesis: must parse as URL with a host.
        if let url = URL(string: entry.endpoint), url.host != nil {
            // OK
        } else {
            errors.append(.init(field: .endpoint, message: "endpoint must be a URL"))
        }
        return errors
    }

    // MARK: - Serializer

    /// Emit array-of-tables form. Keys are emitted in a stable order so
    /// diffs stay legible across edits.
    static func serialize(_ entries: [AgentEntry]) -> String {
        var out = ""
        out.append("# agents.toml — managed by Nexus Settings → Agents.\n")
        out.append("# Hand-edits remain supported; the parser tolerates\n")
        out.append("# `# comments`, blank lines, and key=value scalars.\n\n")
        for entry in entries {
            out.append("[[agents]]\n")
            out.append("name = \"\(escape(entry.name))\"\n")
            out.append("host = \"\(escape(entry.host))\"\n")
            out.append("port = \(entry.port)\n")
            if let user = entry.user, !user.isEmpty {
                out.append("user = \"\(escape(user))\"\n")
            }
            out.append("\n")
        }
        return out
    }

    /// Escape double-quotes and backslashes in TOML basic strings.
    private static func escape(_ s: String) -> String {
        s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}

// MARK: - NotificationCenter contract

public extension Notification.Name {
    /// Posted by SettingsAgentsView after AgentsConfigStore.write succeeds.
    /// NexusAggregateClient debounces + re-bootstraps in response.
    static let agentsConfigChanged = Notification.Name("dev.nexus.AgentsConfigChanged")
}
