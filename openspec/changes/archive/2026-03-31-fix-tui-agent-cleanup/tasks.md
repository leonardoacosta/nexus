# Implementation Tasks

<!-- beads:epic:TBD -->

## Receiver Handler Extraction Batch

- [ ] [1.1] [P-1] Extract each match arm in handle_request into dedicated async functions (handle_health, handle_speak, handle_play, handle_mode_get, handle_mode_set, handle_mode_cycle, handle_reload, handle_watch_register, handle_imessage, handle_history, handle_messages, handle_status_notifications) [owner:engineer]
- [ ] [1.2] [P-2] Reduce handle_request to thin dispatch table that delegates to extracted handler functions [owner:engineer]

## Receiver Axum Migration Batch

- [ ] [2.1] [P-1] Create axum Router in ReceiverService with routes matching existing paths and methods [owner:engineer]
- [ ] [2.2] [P-1] Convert extracted handler functions to axum handler signatures (State extractor for ReceiverState, Json extractor for request bodies) [owner:engineer]
- [ ] [2.3] [P-2] Replace TcpListener accept loop with axum::serve, remove parse_request, format_response, handle_connection [owner:engineer]
- [ ] [2.4] [P-2] Verify all 15 routes return identical status codes and response formats as before migration [owner:engineer]

## TUI Config Watcher Fix Batch

- [ ] [3.1] [P-1] Add RpcCommand::ReloadConfig(NexusConfig) variant to carry reloaded config to background_task [owner:engineer]
- [ ] [3.2] [P-1] Update spawn_config_watcher to send RpcCommand::ReloadConfig instead of only RpcResult::ConfigChanged [owner:engineer]
- [ ] [3.3] [P-2] Handle ReloadConfig in background_task: update NexusClient agent list, connect new agents, drop removed agents [owner:engineer]
- [ ] [3.4] [P-2] Keep existing ConfigChanged toast notification alongside the actual config propagation [owner:engineer]

## TUI Prompt DRY Batch

- [ ] [4.1] [P-1] Add App::submit_prompt method to app.rs encapsulating the full prompt submission sequence [owner:engineer]
- [ ] [4.2] [P-2] Replace inline prompt logic in keys.rs Enter handler with app.submit_prompt() call [owner:engineer]
- [ ] [4.3] [P-2] Replace inline prompt logic in ui_helpers.rs editor submit with app.submit_prompt() call [owner:engineer]

## Verification Batch

- [ ] [5.1] Verify cargo build succeeds for nexus-agent and nexus-tui [owner:engineer]
- [ ] [5.2] Verify cargo test passes for nexus-agent and nexus-tui with no regressions [owner:engineer]
- [ ] [5.3] Verify cargo clippy reports no new warnings [owner:engineer]
