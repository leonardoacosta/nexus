# Implementation Tasks

## Deploy Batch

- [x] [1.1] [P-1] Stop nexus-agent service: `systemctl --user stop nexus-agent` [owner:user]
- [x] [1.2] [P-1] Back up current binary: `cp ~/.local/bin/nexus-agent ~/.local/bin/nexus-agent.bun.bak` [owner:user]
- [x] [1.3] [P-1] Copy Rust binary: `cp ~/dev/nx/target/release/nexus-agent ~/.local/bin/nexus-agent` [owner:user]
- [x] [1.4] [P-1] Start nexus-agent service: `systemctl --user start nexus-agent` [owner:user]

## Verification Batch

- [x] [2.1] [P-1] Verify service is running: `systemctl --user status nexus-agent` shows `active (running)` with no restart loops [owner:user]
- [x] [2.2] [P-1] Verify HTTP health: `curl http://localhost:7402/health` returns 200 [owner:user]
- [x] [2.3] [P-1] Verify credentials endpoint: `curl http://localhost:7402/credentials` returns JSON account list with 17 accounts [owner:user]
- [x] [2.4] [P-2] Verify gRPC on port 7400 still works: confirm TUI or dashboard can connect and stream events [owner:user]
- [x] [2.5] [P-2] Check logs for errors: `journalctl --user -u nexus-agent --since "5 min ago" --no-pager` shows clean startup with no panics or error-level entries [owner:user]

## Cleanup Batch

- [ ] [3.1] [P-3] Clean up backup after confirming multi-day stability: `rm ~/.local/bin/nexus-agent.bun.bak` [owner:user]
