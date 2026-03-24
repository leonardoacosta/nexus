# Scope Lock — Production Hardening

> Locked: 2026-03-23
> Previous phase: MVP (docs/plan/archive/2026-03-23-mvp/)
> Owner: leonardoacosta

## Vision

Make Nexus reliable enough to run unattended across homelab + Mac, ship remaining M3 features,
and establish a test foundation that prevents regressions.

**One sentence:** "Stop babysitting the agent, finish the TUI feature set, prove it works with tests."

## Goals

### G1: Reliability

Fix the runtime issues discovered during MVP that make Nexus fragile:

| Issue | Target |
|-------|--------|
| Port drift (8400 vs 7400/7401) | Investigate root cause, ensure consistent port binding |
| Memory (peaked 1.3G, settled 450M) | < 250M steady-state under normal load |
| No graceful shutdown | Drain gRPC streams + notify clients on SIGTERM, 5s drain window |
| No auto-reconnect | TUI reconnects automatically when agent restarts |
| Nova connectivity errors | Surface meaningful error messages for DNS resolution failures |

### G2: M3 Features

Complete the remaining M3 milestone items from the MVP PRD:

| ID | Feature | Description |
|----|---------|-------------|
| T4 | Session Detail | Full detail screen — agent activity, metadata, status history |
| T7 | Command Palette | Fuzzy search across sessions, projects, and actions |
| T13 | Start Session | TUI invokes StartSession RPC, prompts for project/cwd |

### G3: Test Foundation

Establish integration test coverage to prevent regressions:

| Layer | Coverage |
|-------|----------|
| gRPC round-trip | Spin up agent in-process, test RPCs through real tonic client |
| TUI rendering | ratatui TestBackend snapshot tests for key screens |

### G4: Operational Maturity

| Item | Description |
|------|-------------|
| Config hot-reload | Agent reloads agents.toml without restart (inotify/FSEvents) |
| Binary size targets | Measure release binaries, set target, optimize if needed |

## Non-Goals (Out of Scope)

- **iMessage integration (I1-I5)** — deferred to a future feature phase. Not hardening.
- **Prometheus /metrics endpoint** — not needed for a 2-machine setup
- **Split pane streams** — UX feature, not hardening
- **Web dashboard** — future surface
- **Hook migration stabilization (A11)** — Option B is already shipping; soak period is passive, not active work
- **Memory target < 100M** — too aggressive for this phase. Target < 250M.
- **Major architectural rewrites** — optimize within current architecture

## Priority Order

1. **Reliability fixes** (G1) — unblocks daily use without manual intervention
2. **Test foundation** (G3) — prevents regressions while shipping features
3. **M3 features** (G2) — complete the TUI feature set
4. **Operational maturity** (G4) — config reload + binary size

## Hard Constraints

| Constraint | Detail |
|------------|--------|
| Backward compat | gRPC proto changes must be additive (Nova is a live consumer) |
| Ports | Must bind 7400 (gRPC) + 7401 (HTTP). Investigate why 8400 appeared. |
| Deploy | Both systemd (Linux) and launchd (Mac) are deployed and working |
| Memory | < 250M steady-state for agent daemon |
| Shutdown | Drain + notify: send GoingAway to streams, 5s drain, then exit |
| Tests | gRPC integration + TUI snapshot tests required before feature work |

## Timeline

No external deadline. Internal quality bar: "run for a week without manual restarts."

## Success Criteria

- Agent runs 7 days without manual intervention on both homelab and Mac
- TUI auto-reconnects after agent restart within 5s
- Memory stays < 250M under normal operation (5-10 sessions)
- All M3 features (T4, T7, T13) functional
- Integration test suite covers all gRPC RPCs
- TUI snapshot tests cover dashboard, stream, and detail screens
- Release binaries measured and documented

## Assumptions Corrected

- **"Port drift is a config issue"** → Needs investigation. May be binary mismatch (old binary on PATH), systemd environment, or a code bug. Don't assume the cause.
- **"iMessage is small work"** → It's a new surface with its own integration layer. Correctly deferred.
- **"Memory is fine for homelab"** → 450M+ for a session tracker is excessive even on homelab. Profile and fix.
