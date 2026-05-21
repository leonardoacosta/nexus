---
status: draft
---

# Proposal: health-tab-process-view

## Why

The Swift dashboard's Health tab shows three time-series charts (CPU /
RAM / Disk) but nothing about the **actual processes** consuming those
resources. When the homelab agent's RAM chart spikes to 80%, the user
has no way to know which process is responsible without SSHing in and
running `htop`.

The backend infrastructure already exists:

```ts
// packages/core/src/types/health.ts
processes?: {
  top_cpu: ProcessInfo[];
  top_ram: ProcessInfo[];
};

// apps/agent/src/health-collector.ts
const ps = await si.processes();
metrics.processes = {
  top_cpu: topN(ps.list, "cpu", 5),
  top_ram: topN(ps.list, "mem", 5),
};
```

The data is collected via `systeminformation` and exposed via
`GET /health?detail=true`. What's missing:

1. **No dedicated endpoint** — fetching processes requires the full
   health payload. A `GET /health/processes` route would let the UI
   poll just the process list at a different cadence than the broader
   time-series rollup.
2. **Minimal ProcessInfo shape** — `{ pid, name, cpu_percent, ram_percent }`
   is too thin. btop shows command/user/state which is what makes a
   process recognisable (distinguishing `bun` from `claude` from
   `Cursor Helper`).
3. **No Swift UI** — `HealthView.swift` renders only the SwiftUI Charts
   time series; there's no process table.

## What Changes

1. **Extend `ProcessInfo`** — add optional `command: string?`,
   `user: string?`, `state: string?`. Optional so old agents stay
   wire-compatible. `command` is the full command-line (truncated at
   200 chars); `user` is the owner; `state` is the kernel state
   character (R/S/D/Z/I).

2. **Extend the collector** — `topN()` in `health-collector.ts` maps
   the new fields from `systeminformation`'s richer
   `ProcessesProcessData` shape (which already includes `command`,
   `user`, `state`). One-line extension; no extra subprocess.

3. **Dedicated `GET /health/processes` endpoint** — returns just
   `{ top_cpu: ProcessInfo[], top_ram: ProcessInfo[], collectedAt }`.
   Same data the collector caches; no recomputation. Accepts optional
   `?limit=N` parameter (default 10, max 50).

4. **`/health` payload preserved** — the existing `?detail=true`
   behavior is unchanged for back-compat. The new endpoint is purely
   additive.

5. **HealthView process table** — below the three time-series charts,
   add a `ProcessTableView` showing two columns (top CPU / top RAM)
   sorted by their respective metric. Each row: PID monospace, name
   bold, user/command grey caption, cpu%/ram% bar visual. Refresh
   every 5 seconds (auto) plus pull-down (Cmd+R).

6. **Reuse the existing `?machine=` selector** — the agent-aggregate
   client already fans out across machines for `/health/history`.
   Same fan-out pattern applies to `/health/processes`.

## Context

- depends on: 
- touches: `packages/core/src/types/health.ts`, `apps/agent/src/health-collector.ts`, `apps/agent/src/health-collector.test.ts`, `apps/agent/src/routes/health-processes.ts`, `apps/agent/src/routes/health-processes.test.ts`, `apps/agent/src/server-request-handler.ts`, `apps/swift/NexusShared/Models/ProcessInfo.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/HealthView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/ProcessTableView.swift`

NexusClient + NexusAggregateClient shared with the two earlier
session-scaffolded specs (`specs-tab-start-on-spec`,
`projects-tab-accordion-deeplink`). `wave-plan-build` will serialize
all three. Append-only changes to the clients (different methods
per spec), so order does not matter.

`packages/core/src/types/health.ts` is the wire-format types package.
Adding optional fields is back-compat: old Swift clients ignore the
new fields, old agents return objects without them and the new Swift
decoder defaults them to nil.

## Risk

- **Process snapshot cost.** `systeminformation`'s `processes()` call
  enumerates `/proc` (Linux) or syscall (macOS) — typically 50-200ms.
  Already accepted by the collector (called every 10s). The new
  endpoint just returns the cached snapshot; zero additional cost.
- **Command-line truncation.** Very long command lines (build tools,
  java apps) bloat the payload. Mitigation: truncate at 200 chars
  with a trailing ellipsis. The PID + name preserve identity even
  when the command is truncated.
- **Cross-platform user resolution.** `systeminformation` returns
  numeric UID on Linux, username on macOS. Mitigation: best-effort
  passthrough — if `user` is a string of all digits, the Swift UI
  shows it as `uid:NNNN`; otherwise as-is. No agent-side resolution
  to avoid platform-specific code paths.
- **Stale snapshot drift.** The cached snapshot is up to 10s old
  (collector tick interval). Mitigation: the response includes
  `collectedAt` ISO timestamp. The Swift UI greys the table if
  `now - collectedAt > 30s` ("snapshot stale").
- **`systeminformation` state strings differ.** Linux returns `R/S/D/Z/I`;
  macOS may return `running/sleeping/etc`. Mitigation: pass through
  whatever the lib returns; UI shows the raw string. Cross-platform
  normalisation is out of scope.
