## Summary

Replace text percentages on the health screen with LineGauge widgets for CPU/RAM and Sparkline widgets for historical trends. Add a ring buffer in the TUI to store 1 hour of metric samples.

## Motivation

Health screen displays raw text like "45.2%" and "3.2/8.0 GB" with no visual representation. btop-quality tools show bars, gauges, and trend lines. The data exists (CPU/RAM values via sysinfo) but rendering is text-only.

## Approach

1. Add `VecDeque<u64>` ring buffer per agent in App state for CPU and RAM history (1 hour at 2s refresh = 1800 samples)
2. On each health refresh, push current values into the ring buffer
3. Replace text CPU percentage with `LineGauge` widget colored by threshold (cpu_color() already exists)
4. Replace text RAM with `LineGauge` widget (used/total ratio)
5. Add `Sparkline` widget below each gauge showing trend over the buffer window
6. Wrap health cards in `Block` with rounded borders and padding

## Files Modified

- `crates/nexus-tui/src/app.rs` — add ring buffer fields (per-agent health history)
- `crates/nexus-tui/src/screens/health.rs` — replace text rendering with LineGauge + Sparkline + Block cards
