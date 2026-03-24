## 1. Layout
- [ ] 1.1 Design 3-panel layout using ratatui Layout::horizontal + vertical splits
- [ ] 1.2 Left panel (30%): session metadata in key-value pairs
- [ ] 1.3 Center panel (40%): status timeline (vertical list of transitions)
- [ ] 1.4 Right panel (30%): live stream output if attached, otherwise "not streaming"

## 2. Metadata Panel
- [ ] 2.1 Display: session ID (truncated), project code, branch, cwd
- [ ] 2.2 Display: session type badge ([M] managed / [A] ad-hoc)
- [ ] 2.3 Display: started_at (relative time), last_heartbeat (relative time), uptime
- [ ] 2.4 Display: current status with colored dot, agent name

## 3. Status Timeline
- [ ] 3.1 Request StatusTransition history from agent (may need proto addition or local tracking)
- [ ] 3.2 Render vertical timeline: each entry shows timestamp, from→to status, reason
- [ ] 3.3 Color-code transitions: green for healthy, amber for idle, red for error/stale

## 4. Navigation
- [ ] 4.1 `d` on dashboard selected session → opens detail view with that session
- [ ] 4.2 `q` from detail → returns to dashboard, preserving dashboard scroll position
- [ ] 4.3 `a` from detail → attach to stream (switches to stream view)
- [ ] 4.4 Auto-refresh metadata every 2s while on detail screen

## 5. Validation
- [ ] 5.1 Navigate to detail from dashboard, verify all metadata fields populated
- [ ] 5.2 Verify status timeline renders with colored transitions
- [ ] 5.3 `cargo clippy && cargo test` passes
