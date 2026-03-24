## 1. History Buffer
- [ ] 1.1 Add `health_history: HashMap<String, AgentHealthHistory>` to App struct (app.rs)
- [ ] 1.2 Define `AgentHealthHistory { cpu: VecDeque<u64>, ram: VecDeque<u64>, disk: VecDeque<u64> }` with capacity 1800 (1 hour at 2s intervals)
- [ ] 1.3 On each `update_agents()` call, push current CPU/RAM/Disk values into the ring buffer, truncating to capacity
- [ ] 1.4 Initialize history for new agents, clean up for disconnected agents

## 2. Gauge Rendering
- [ ] 2.1 Replace text CPU percentage (health.rs ~lines 112-118) with `LineGauge` widget
- [ ] 2.2 Color gauge using existing `cpu_color()` function for threshold-based coloring
- [ ] 2.3 Replace text RAM display (health.rs ~lines 120-125) with `LineGauge` (used/total ratio)
- [ ] 2.4 Add `LineGauge` for disk usage
- [ ] 2.5 Show numeric value as label inside or beside each gauge

## 3. Sparkline Rendering
- [ ] 3.1 Add `Sparkline` widget below CPU gauge, fed from `health_history[agent].cpu`
- [ ] 3.2 Add `Sparkline` widget below RAM gauge, fed from `health_history[agent].ram`
- [ ] 3.3 Style sparklines with appropriate colors (match gauge colors)

## 4. Card Layout
- [ ] 4.1 Wrap each agent's health section in `Block` with `BorderType::Rounded` and `Padding::horizontal(1)`
- [ ] 4.2 Layout: agent name title → CPU gauge+sparkline → RAM gauge+sparkline → Disk gauge → Docker table (if any)

## 5. Validation
- [ ] 5.1 `cargo build` passes
- [ ] 5.2 `cargo test` — all tests pass
- [ ] 5.3 Manual smoke: launch TUI, wait 30s, verify gauges animate and sparklines show trend data
