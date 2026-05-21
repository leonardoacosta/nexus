// HealthMetrics — Codable mirror of the agent's `GET /health` payload.
//
// Spec: openspec/changes/extend-integration-gate-liveness-payloads (task 2.1)
//
// Source of truth: packages/core/src/types/health.ts (`HealthMetrics`).
// Carries the system metrics block PLUS the three liveness fields added by
// the same change proposal. Each liveness field uses a safe default so
// dashboards survive responses from an OLDER agent that pre-dates the
// liveness extension (those payloads simply omit the keys).
//
// Field-level fallback semantics (mirrors the agent's per-field try block):
//   - db_ok                  -> false   (assume unhealthy when missing)
//   - last_watcher_tick_ms   -> -1      (sentinel: watcher never ticked)
//   - socket_server_listening -> false  (assume the spine isn't up)
//
// The decoder is permissive on the rest of the payload too: optional system
// metric branches (network, processes, docker) decode via decodeIfPresent
// so an absent field never throws.

import Foundation

public struct HealthMetrics: Equatable, Hashable, Codable, Sendable {
    public var hostname: String
    public var uptimeSeconds: Double
    public var collectedAt: Date?
    public var cpu: CPU
    public var ram: RAM
    public var disk: [Disk]
    public var docker: Docker?
    public var network: [NetworkIface]?
    public var processes: Processes?

    /// Liveness — Drizzle pool can issue a trivial `select 1`. False on a
    /// dead pool / timeout / refused connection. Safe default `false` when
    /// the field is absent from an older agent's response.
    public var dbOk: Bool
    /// Liveness — monotonic ms since the watcher's `reconcileOnce()` last
    /// completed. Sentinel `-1` means "watcher has not ticked yet" and is
    /// also the default for older agents.
    public var lastWatcherTickMs: Int64
    /// Liveness — UNIX socket spine is bound and accepting. Safe default
    /// `false` so a missing field never paints a green check on stale data.
    public var socketServerListening: Bool

    public struct CPU: Equatable, Hashable, Codable, Sendable {
        public var overallPercent: Double
        public var perCorePercent: [Double]
        public var loadAverage: [Double]

        public enum CodingKeys: String, CodingKey {
            case overallPercent  = "overall_percent"
            case perCorePercent  = "per_core_percent"
            case loadAverage     = "load_average"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.overallPercent = (try? c.decode(Double.self, forKey: .overallPercent)) ?? 0
            self.perCorePercent = (try? c.decode([Double].self, forKey: .perCorePercent)) ?? []
            self.loadAverage    = (try? c.decode([Double].self, forKey: .loadAverage)) ?? []
        }

        public init(overallPercent: Double, perCorePercent: [Double], loadAverage: [Double]) {
            self.overallPercent = overallPercent
            self.perCorePercent = perCorePercent
            self.loadAverage    = loadAverage
        }
    }

    public struct RAM: Equatable, Hashable, Codable, Sendable {
        public var totalBytes: Int64
        public var usedBytes: Int64
        public var percent: Double

        public enum CodingKeys: String, CodingKey {
            case totalBytes = "total_bytes"
            case usedBytes  = "used_bytes"
            case percent
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.totalBytes = (try? c.decode(Int64.self, forKey: .totalBytes)) ?? 0
            self.usedBytes  = (try? c.decode(Int64.self, forKey: .usedBytes)) ?? 0
            self.percent    = (try? c.decode(Double.self, forKey: .percent)) ?? 0
        }

        public init(totalBytes: Int64, usedBytes: Int64, percent: Double) {
            self.totalBytes = totalBytes
            self.usedBytes  = usedBytes
            self.percent    = percent
        }
    }

    public struct Disk: Equatable, Hashable, Codable, Sendable {
        public var mount: String
        public var totalBytes: Int64
        public var usedBytes: Int64
        public var percent: Double

        public enum CodingKeys: String, CodingKey {
            case mount
            case totalBytes = "total_bytes"
            case usedBytes  = "used_bytes"
            case percent
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.mount      = (try? c.decode(String.self, forKey: .mount)) ?? ""
            self.totalBytes = (try? c.decode(Int64.self, forKey: .totalBytes)) ?? 0
            self.usedBytes  = (try? c.decode(Int64.self, forKey: .usedBytes)) ?? 0
            self.percent    = (try? c.decode(Double.self, forKey: .percent)) ?? 0
        }

        public init(mount: String, totalBytes: Int64, usedBytes: Int64, percent: Double) {
            self.mount      = mount
            self.totalBytes = totalBytes
            self.usedBytes  = usedBytes
            self.percent    = percent
        }
    }

    public struct Docker: Equatable, Hashable, Codable, Sendable {
        public var containers: Int
        public var running: Int
    }

    public struct NetworkIface: Equatable, Hashable, Codable, Sendable {
        public var iface: String
        public var rxBytes: Int64
        public var txBytes: Int64

        public enum CodingKeys: String, CodingKey {
            case iface
            case rxBytes = "rx_bytes"
            case txBytes = "tx_bytes"
        }
    }

    public struct ProcessInfo: Equatable, Hashable, Codable, Sendable {
        public var pid: Int
        public var name: String
        public var cpuPercent: Double
        public var ramPercent: Double

        // Optional fields added by `health-tab-process-view` so older agents
        // that emit only `{pid,name,cpu_percent,ram_percent}` still decode.
        // `command` is truncated agent-side at 200 chars + "…".
        public var command: String?
        public var user: String?
        public var state: String?

        public enum CodingKeys: String, CodingKey {
            case pid, name
            case cpuPercent = "cpu_percent"
            case ramPercent = "ram_percent"
            case command, user, state
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.pid        = (try? c.decode(Int.self, forKey: .pid)) ?? 0
            self.name       = (try? c.decode(String.self, forKey: .name)) ?? ""
            self.cpuPercent = (try? c.decode(Double.self, forKey: .cpuPercent)) ?? 0
            self.ramPercent = (try? c.decode(Double.self, forKey: .ramPercent)) ?? 0
            // Optional new fields — `try?` plus decodeIfPresent so both
            // {field missing} AND {field present but null} decode cleanly
            // to nil. Older agents that omit the keys, and newer agents
            // that emit `null`, both produce `nil` here.
            self.command = (try? c.decodeIfPresent(String.self, forKey: .command)) ?? nil
            self.user    = (try? c.decodeIfPresent(String.self, forKey: .user)) ?? nil
            self.state   = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil
        }

        public init(
            pid: Int,
            name: String,
            cpuPercent: Double,
            ramPercent: Double,
            command: String? = nil,
            user: String? = nil,
            state: String? = nil
        ) {
            self.pid = pid
            self.name = name
            self.cpuPercent = cpuPercent
            self.ramPercent = ramPercent
            self.command = command
            self.user = user
            self.state = state
        }
    }

    public struct Processes: Equatable, Hashable, Codable, Sendable {
        public var topCpu: [ProcessInfo]
        public var topRam: [ProcessInfo]

        public enum CodingKeys: String, CodingKey {
            case topCpu = "top_cpu"
            case topRam = "top_ram"
        }
    }

    public enum CodingKeys: String, CodingKey {
        case hostname
        case uptimeSeconds = "uptime_seconds"
        case collectedAt
        case cpu
        case ram
        case disk
        case docker
        case network
        case processes
        case dbOk                  = "db_ok"
        case lastWatcherTickMs     = "last_watcher_tick_ms"
        case socketServerListening = "socket_server_listening"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.hostname      = (try? c.decode(String.self, forKey: .hostname)) ?? ""
        self.uptimeSeconds = (try? c.decode(Double.self, forKey: .uptimeSeconds)) ?? 0
        if let s = try c.decodeIfPresent(String.self, forKey: .collectedAt) {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            self.collectedAt = f1.date(from: s) ?? f2.date(from: s)
        } else {
            self.collectedAt = nil
        }
        self.cpu       = (try? c.decode(CPU.self, forKey: .cpu)) ?? CPU(overallPercent: 0, perCorePercent: [], loadAverage: [])
        self.ram       = (try? c.decode(RAM.self, forKey: .ram)) ?? RAM(totalBytes: 0, usedBytes: 0, percent: 0)
        self.disk      = (try? c.decode([Disk].self, forKey: .disk)) ?? []
        self.docker    = try c.decodeIfPresent(Docker.self, forKey: .docker)
        self.network   = try c.decodeIfPresent([NetworkIface].self, forKey: .network)
        self.processes = try c.decodeIfPresent(Processes.self, forKey: .processes)

        // Safe defaults — an older agent omits these keys entirely. The
        // dashboard MUST NOT paint "healthy" on missing data.
        self.dbOk                  = (try? c.decodeIfPresent(Bool.self, forKey: .dbOk)) ?? false
        self.lastWatcherTickMs     = (try? c.decodeIfPresent(Int64.self, forKey: .lastWatcherTickMs)) ?? -1
        self.socketServerListening = (try? c.decodeIfPresent(Bool.self, forKey: .socketServerListening)) ?? false
    }

    public init(
        hostname: String,
        uptimeSeconds: Double,
        collectedAt: Date? = nil,
        cpu: CPU,
        ram: RAM,
        disk: [Disk],
        docker: Docker? = nil,
        network: [NetworkIface]? = nil,
        processes: Processes? = nil,
        dbOk: Bool = false,
        lastWatcherTickMs: Int64 = -1,
        socketServerListening: Bool = false
    ) {
        self.hostname = hostname
        self.uptimeSeconds = uptimeSeconds
        self.collectedAt = collectedAt
        self.cpu = cpu
        self.ram = ram
        self.disk = disk
        self.docker = docker
        self.network = network
        self.processes = processes
        self.dbOk = dbOk
        self.lastWatcherTickMs = lastWatcherTickMs
        self.socketServerListening = socketServerListening
    }
}

// MARK: - HealthProcessesResponse

/// Codable mirror of `GET /health/processes` response. Added by
/// `health-tab-process-view`; uses the same `ProcessInfo` shape that
/// `HealthMetrics.Processes` carries so the dashboard never has to
/// re-decode the rows. `collectedAt` is optional — the agent returns
/// `null` while the collector is warming up.
public struct HealthProcessesResponse: Equatable, Hashable, Codable, Sendable {
    public var topCpu: [HealthMetrics.ProcessInfo]
    public var topRam: [HealthMetrics.ProcessInfo]
    public var collectedAt: Date?

    public enum CodingKeys: String, CodingKey {
        case topCpu = "top_cpu"
        case topRam = "top_ram"
        case collectedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.topCpu = (try? c.decode([HealthMetrics.ProcessInfo].self, forKey: .topCpu)) ?? []
        self.topRam = (try? c.decode([HealthMetrics.ProcessInfo].self, forKey: .topRam)) ?? []
        // Same ISO-8601 dual-formatter dance as HealthMetrics.collectedAt.
        if let s = try? c.decodeIfPresent(String.self, forKey: .collectedAt), let s {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            self.collectedAt = f1.date(from: s) ?? f2.date(from: s)
        } else {
            self.collectedAt = nil
        }
    }

    public init(
        topCpu: [HealthMetrics.ProcessInfo],
        topRam: [HealthMetrics.ProcessInfo],
        collectedAt: Date? = nil
    ) {
        self.topCpu = topCpu
        self.topRam = topRam
        self.collectedAt = collectedAt
    }
}
