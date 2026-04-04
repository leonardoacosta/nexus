# Implementation Tasks

<!-- beads:epic:nx-8f0 -->

## Client Batch

- [x] [1.1] [P-1] Add get_health_time_series() method to NexusClient in client.rs — fan out across agents, merge results tagged by agent [beads:nx-6gp]
- [x] [1.2] [P-1] Add get_session_history() method to NexusClient in client.rs — fan out, merge, optional project filter [beads:nx-bzv]
- [x] [1.3] [P-1] Add get_failure_trends() method to NexusClient in client.rs — fan out, merge daily+by_tool [beads:nx-kik]
- [x] [1.4] [P-1] Add get_spec_velocity() method to NexusClient in client.rs — fan out, merge, optional project filter [beads:nx-10j]

## Plumbing Batch

- [x] [2.1] [P-1] Add RpcCommand variants (FetchHealthTimeSeries, FetchSessionHistory, FetchFailureTrends, FetchSpecVelocity) and RpcResult variants to main.rs [beads:nx-pd3]
- [x] [2.2] [P-1] Add analytics cache fields to App struct in app.rs (health_time_series, session_history, failure_trends, spec_velocity) with update methods [beads:nx-5ie]
- [x] [2.3] [P-2] Add 30s health timeseries timer to background_task in main.rs — calls get_health_time_series, sends via poll_tx or dedicated channel [beads:nx-b6b]
- [x] [2.4] [P-2] Add on-demand dispatch handlers in background_task for the other 3 RPC commands — triggered by screen navigation [beads:nx-4vk]

## Screen Batch

- [x] [3.1] [P-1] Update Health screen to use SQLite-backed timeseries for 24h sparklines — supplement ring buffer with analytical data [beads:nx-0em]
- [x] [3.2] [P-1] Update Dashboard status area with session count sparkline and failure count badge using cached analytics [beads:nx-uao]
- [x] [3.3] [P-1] Update Projects screen with spec velocity column showing aggregated task completion per project [beads:nx-hxm]
- [x] [3.4] [P-1] Update Specs screen with inline velocity trend indicator next to tasks_done/tasks_total [beads:nx-6a1]

## Integration Batch

- [x] [4.1] [P-1] Add on_screen_enter() dispatch in App/main event loop — triggers on-demand RPC when navigating to Dashboard, Projects, or Specs [beads:nx-2bv]
- [x] [4.2] [P-2] Verify full build (cargo build), clippy clean, and cargo test passes [beads:nx-8pq]
