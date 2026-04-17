# Financial Projections — Nexus v2

> Generated: 2026-04-03
> Source: docs/plan/v2/scope-lock.md
> Model: Cost-only (internal tool, zero revenue)

## Business Model

**Internal team tool. No revenue. No SaaS. No pricing.**

Nexus v2 is built for one team (2-5 developers, 3-5 machines). Value is measured in developer
productivity, not revenue. Financial analysis focuses on cost to build, cost to run, and
time-saved ROI.

---

## 1. Development Cost

### Effort Estimate

| Component | Estimated Hours | Notes |
|-----------|---------------:|-------|
| Agent daemon (Bun, compiled binary) | 80 | Session detection, health monitoring, WebSocket relay, SQLite |
| Next.js web dashboard | 120 | Server Actions, real-time session streaming, interactive terminal |
| Rust file watcher (carry forward) | 8 | IPC integration with Bun agent, minor adaptation |
| Meeting-aware notifications | 24 | Port from Rust, adapt to new architecture |
| Credential pool management | 16 | Port from Rust, simplify for HTTP/WebSocket |
| SQLite analytics layer | 24 | Schema design, queries, per-agent + central stores |
| Testing & QA | 40 | New test suite (Rust tests not ported) |
| Integration & polish | 32 | Cross-machine testing, systemd/launchd configs, edge cases |
| **Total** | **344** | |

### Cost at Internal Rate

| Rate Assumption | Total Cost |
|-----------------|-----------|
| $100/hr (mid-market senior) | $34,400 |
| $150/hr (senior + AI tooling overhead) | $51,600 |
| $75/hr (internal allocation, no margin) | $25,800 |

**Working estimate: ~344 hours / ~$34,400 at $100/hr internal rate.**

Calendar time: 6-10 weeks at ~40-60 hrs/week effective development (no external deadline).

### AI-Assisted Development Discount

Claude Code is the primary development tool. Based on observed productivity multipliers
across the team's 14 T3 projects:

| Factor | Multiplier |
|--------|-----------|
| Boilerplate generation (Next.js, Server Actions) | 2-3x faster |
| Port logic from Rust (known patterns, existing specs) | 1.5-2x faster |
| Test generation | 2x faster |
| Novel architecture (WebSocket relay, terminal streaming) | 1x (no speedup) |

**Effective hours with AI assist: ~230-260 hours** (25-30% reduction).
Adjusted cost: ~$23,000-$26,000 at $100/hr.

---

## 2. Infrastructure Cost

### Runtime Costs

| Service | Cost | Notes |
|---------|-----:|-------|
| Tailscale | $0 | Free tier (up to 100 devices) or existing team plan |
| Bun runtime | $0 | Open source, self-hosted on existing machines |
| SQLite | $0 | Embedded, no server cost |
| systemd/launchd | $0 | OS-native service management |
| Vercel (dashboard hosting) | $0-20/mo | Free tier likely sufficient; Pro if needed |
| Self-hosted dashboard (alternative) | $0 | Runs on existing Tailscale machine |

**Monthly infrastructure cost: $0-20/mo ($0-240/yr)**

### Hardware (Already Owned)

No new hardware required. Agent daemons run on existing dev machines (3-5 machines
already on Tailscale). Dashboard runs on one of those machines or Vercel free tier.

### Total Infrastructure — Year 1

| Scenario | Annual Cost |
|----------|------------|
| Self-hosted dashboard | $0 |
| Vercel free tier | $0 |
| Vercel Pro | $240 |

---

## 3. Maintenance Cost Projection

### Year 1 (Post-Launch)

| Activity | Hours/Month | Annual Hours | Annual Cost ($100/hr) |
|----------|----------:|------------:|---------:|
| Bug fixes & patches | 4 | 48 | $4,800 |
| Dependency updates (Bun, Next.js) | 2 | 24 | $2,400 |
| Feature additions (incremental) | 8 | 96 | $9,600 |
| Machine onboarding (new agents) | 0.5 | 6 | $600 |
| **Total** | **14.5** | **174** | **$17,400** |

### Year 2-3 (Steady State)

| Activity | Hours/Month | Annual Hours | Annual Cost ($100/hr) |
|----------|----------:|------------:|---------:|
| Bug fixes & patches | 2 | 24 | $2,400 |
| Dependency updates | 2 | 24 | $2,400 |
| Feature additions (light) | 4 | 48 | $4,800 |
| **Total** | **8** | **96** | **$9,600** |

---

## 4. Total Cost of Ownership

### 3-Year Projection

| Period | Development | Infrastructure | Maintenance | Total |
|--------|----------:|-------------:|-----------:|------:|
| Year 0 (build) | $26,000 | $0 | $0 | $26,000 |
| Year 1 (post-launch) | $0 | $120 | $17,400 | $17,520 |
| Year 2 | $0 | $120 | $9,600 | $9,720 |
| Year 3 | $0 | $120 | $9,600 | $9,720 |
| **3-Year Total** | **$26,000** | **$360** | **$36,600** | **$62,960** |

Infrastructure is negligible. The dominant cost is human time.

---

## 5. ROI — Time Saved vs. Time Invested

### Current Pain (Without Nexus v2 Web Dashboard)

Daily developer friction for a team of 3 developers (conservative):

| Activity | Time Lost/Day/Dev | Annual (250 days, 3 devs) |
|----------|------------------:|----------:|
| SSH into machines to check session status | 10 min | 187.5 hrs |
| Context switching between terminals | 15 min | 281.3 hrs |
| Missed session outputs (re-running, re-reading) | 10 min | 187.5 hrs |
| Manual health checks across machines | 5 min | 93.8 hrs |
| Coordinating who's working on what | 10 min | 187.5 hrs |
| **Total friction** | **50 min/day/dev** | **937.5 hrs/yr** |

### With Nexus v2 (Estimated Reduction)

| Activity | Reduction | Hours Saved/Year |
|----------|----------:|---------:|
| Session status → single dashboard | 90% | 168.8 |
| Context switching → stream in browser | 70% | 196.9 |
| Missed outputs → real-time streaming | 80% | 150.0 |
| Health checks → dashboard health view | 95% | 89.1 |
| Coordination → visible session list | 60% | 112.5 |
| **Total saved** | | **717.3 hrs/yr** |

### Payback Calculation

| Metric | Value |
|--------|-------|
| Development cost | ~$26,000 (260 hrs) |
| Annual time saved | ~717 hrs |
| Value of saved time ($100/hr) | ~$71,700/yr |
| **Payback period** | **~4.3 months** |
| Year 1 net value (post-launch) | $71,700 - $17,520 = **$54,180** |
| 3-year net value | $215,100 - $62,960 = **$152,140** |
| 3-year ROI | **342%** |

### Sensitivity Analysis

| Scenario | Time Saved/Yr | Payback Period | 3-Year ROI |
|----------|-------------:|---------------:|----------:|
| Optimistic (5 devs, 60 min/day friction) | 1,250 hrs | 2.5 months | 595% |
| Base case (3 devs, 50 min/day friction) | 717 hrs | 4.3 months | 342% |
| Conservative (2 devs, 30 min/day friction) | 250 hrs | 12.5 months | 95% |
| Pessimistic (2 devs, 15 min/day friction) | 125 hrs | 25 months | -1% |

Even in the conservative case, Nexus v2 pays for itself within the first year.

---

## 6. Risk Factors

| Risk | Impact | Mitigation |
|------|--------|------------|
| Bun instability (young runtime) | Medium | Can fall back to Node.js; Bun API is Node-compatible |
| Scope creep during build | High | Scope lock enforced; 4 must-do features only |
| Team shrinks to 1 developer | Low financial impact | ROI weakens but tool still valuable for solo multi-machine use |
| Tailscale pricing changes | Negligible | Free tier covers 100 devices; well within 3-5 machine target |
| WebSocket terminal relay complexity | Medium | GoTTY patterns well-documented; incremental delivery |

---

## 7. Comparison: Build vs. Buy

| Option | Cost | Fit |
|--------|------|-----|
| **Build Nexus v2** | ~$63K over 3 years | Purpose-built for Claude Code sessions, multi-machine, team-aware |
| CCManager (open source) | $0 + integration time | Single-machine only, no web UI, no team features |
| GoTTY + custom glue | $5K-10K integration | Terminal sharing only, no session awareness, no aggregation |
| Do nothing (status quo) | $0 direct, ~$94K/yr in lost productivity | Ongoing friction compounds |

**No existing tool solves this problem.** The build option is the only viable path.

---

## Summary

| Metric | Value |
|--------|-------|
| Total build cost | ~$26,000 (260 AI-assisted hours) |
| Annual infrastructure | ~$0-240 |
| Annual maintenance (steady state) | ~$9,600 |
| Annual productivity gain | ~$71,700 (717 hrs saved) |
| Payback period | ~4.3 months |
| 3-year ROI | 342% |
| Business model | Internal tool, zero revenue |

Nexus v2 is a high-ROI internal investment. Near-zero infrastructure cost, fast payback
from developer productivity gains, and no viable alternative on the market.
