# swift-menubar-client Delta

## ADDED Requirements

### Requirement: health-process-table-view
The Health tab MUST render a process-table section below the existing CPU/RAM/Disk time-series charts. The section MUST display two side-by-side columns: top CPU processes (left) and top RAM processes (right). Each row MUST show PID (monospace), process name (bold), user (caption grey), command (caption grey, truncated to fit), and a percentage bar visualising the row's metric. The section MUST auto-refresh every 5 seconds and respond to pull-down (Cmd+R).

#### Scenario: populated process table
- **Given** the agent returned top_cpu: [{pid:1, name:"claude", cpu_percent:45.2, user:"leo", command:"/usr/local/bin/claude..."}] and a parallel top_ram list
- **When** the Health tab renders
- **Then** the process table shows two columns; the left column's first row reads `1` (mono), `claude` (bold), `leo` (caption), command excerpt (caption), `45.2%` bar; the right column mirrors the structure with the top_ram values

#### Scenario: empty processes list
- **Given** the agent response has `top_cpu: []` and `top_ram: []` (collector warming up)
- **When** the Health tab renders
- **Then** the process table section is hidden entirely (no empty placeholder; the time-series charts remain visible)

#### Scenario: numeric uid passed through
- **Given** Linux agent returned `user: "1000"` for a process
- **When** the row renders
- **Then** the user field displays `uid:1000` (prefixed to clarify it's a numeric uid)

#### Scenario: stale snapshot greyed
- **Given** the response's `collectedAt` ISO timestamp is older than 30 seconds (e.g. collector stalled)
- **When** the table renders
- **Then** the entire process table is greyed (50% opacity); a small caption reads "snapshot stale — collector last ticked Xs ago"

### Requirement: health-process-machine-selector-reuse
The Health tab's existing `?machine=` selector MUST drive the process table data source identically to the time-series charts. Switching machines MUST trigger a single refetch covering both the time series and the process snapshot; the process table MUST not display stale data from the previous machine while the new fetch is in flight.

#### Scenario: machine switch
- **Given** the user is viewing Mac's health (process table shows Mac processes)
- **When** the user switches the picker to homelab
- **Then** the process table clears within one render frame and re-populates with homelab processes when the fetch resolves
