## 1. ReconnectManager
- [ ] 1.1 Add `ConnectionState` enum: Connected, Reconnecting { attempt: u32 }, Disconnected { reason: String }
- [ ] 1.2 Add `ReconnectManager` struct with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- [ ] 1.3 On GoingAway event: trigger immediate reconnect (skip backoff, agent is restarting)
- [ ] 1.4 On network error: start backoff sequence

## 2. State Refresh
- [ ] 2.1 On successful reconnect: call GetSessions to refresh all session data
- [ ] 2.2 Re-subscribe to StreamEvents for any active stream views
- [ ] 2.3 Preserve TUI state (scroll position, selected session, active tab) across reconnect

## 3. DNS Error Handling
- [ ] 3.1 Detect DNS resolution failures in tonic connection errors
- [ ] 3.2 Surface as clear status bar message: "homelab: DNS resolution failed (host not found)"
- [ ] 3.3 Do not auto-retry DNS failures — require user intervention (config fix)

## 4. UI Updates
- [ ] 4.1 Status bar: show per-agent connection state with reconnect attempt count
- [ ] 4.2 Dashboard: dim sessions from reconnecting/disconnected agents
- [ ] 4.3 Show "reconnected" toast (PRIMARY green, 3s auto-dismiss) on successful reconnect

## 5. Validation
- [ ] 5.1 Manual test: restart agent, verify TUI reconnects within 5s
- [ ] 5.2 Manual test: stop agent, verify backoff sequence in status bar
- [ ] 5.3 Manual test: configure wrong hostname, verify DNS error message
- [ ] 5.4 `cargo clippy && cargo test` passes
