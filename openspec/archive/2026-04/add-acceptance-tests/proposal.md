# Add Acceptance Tests

## Why
The PRD defines 14 acceptance criteria (AC-1 through AC-14) that constitute the definition of done for Nexus v2. Without automated E2E tests covering every AC, there is no verifiable proof that the system works end-to-end across agents, dashboard, and terminal relay. This spec is the final validation gate before declaring v2 complete.

## What Changes
Build an E2E acceptance test suite using Playwright (dashboard) and Bun test (agent) that covers all 14 ACs. Tests use configurable mock agents to simulate multi-machine scenarios (online, offline, slow, many sessions). A CI pipeline configuration ensures these tests run on every push. The test matrix covers session rendering, empty states, filtering, streaming, scroll-back, offline detection, interactive mode, control characters, resize, health cards, disk warnings, project views, and cross-page navigation flows.
