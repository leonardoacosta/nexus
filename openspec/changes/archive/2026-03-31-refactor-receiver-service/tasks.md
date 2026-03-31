# Implementation Tasks

<!-- beads:epic:TBD -->

## Extract Batch

- [ ] [1.1] [P-1] Extract ReceiverState, mode/type management, and message store functions into receiver/state.rs [owner:engineer]
- [ ] [1.2] [P-1] Extract handle_request, handle_connection, parse_request, format_response into receiver/http_router.rs [owner:engineer]
- [ ] [1.3] [P-1] Extract handle_socket_message and run_socket_listener into receiver/socket.rs [owner:engineer]
- [ ] [1.4] [P-2] Extract notification delivery (show_notification, deliver_to_watch, send_imessage) into receiver/delivery.rs [owner:engineer]
- [ ] [1.5] [P-2] Update receiver/mod.rs to declare new sub-modules and re-export public types [owner:engineer]

## Slim Batch

- [ ] [2.1] [P-1] Reduce service.rs to thin orchestrator — Service trait impl + startup wiring only [owner:engineer]

## Verification Batch

- [ ] [3.1] Verify cargo build -p nexus-agent succeeds [owner:engineer]
- [ ] [3.2] Verify cargo test -p nexus-agent passes with no regressions [owner:engineer]
- [ ] [3.3] Verify service.rs is under 300 lines after refactor [owner:engineer]
