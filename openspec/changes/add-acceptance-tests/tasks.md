## 1. Framework Setup
- [ ] [1.1] Set up Playwright for dashboard E2E tests [owner:engineer]
- [ ] [1.2] Set up Bun test harness for agent integration tests [owner:engineer]
- [ ] [1.3] Implement configurable test agent mocks (online, offline, slow, many sessions) [owner:engineer]

## 2. Session & Dashboard ACs
- [ ] [2.1] AC-1: 3 agents, 5 sessions — all render within 2s [owner:engineer]
- [ ] [2.2] AC-2: 0 sessions, 3 agents — empty state message displays [owner:engineer]
- [ ] [2.3] AC-3: 4 projects — "/" filter isolates one project [owner:engineer]

## 3. Streaming ACs
- [ ] [3.1] AC-4: Active session — stream connects within 500ms [owner:engineer]
- [ ] [3.2] AC-5: 200 lines output — scroll-back to line 1 [owner:engineer]
- [ ] [3.3] AC-6: Agent goes offline — "Machine offline" within 5s [owner:engineer]

## 4. Interactive ACs
- [ ] [4.1] AC-7: Interactive mode — "hello" in stdin within 100ms [owner:engineer]
- [ ] [4.2] AC-8: Ctrl+C — 0x03 sent, interrupt result renders [owner:engineer]
- [ ] [4.3] AC-9: Resize to 120x40 — SIGWINCH propagated [owner:engineer]

## 5. Health ACs
- [ ] [5.1] AC-10: 3 agents — 3 health cards with live metrics [owner:engineer]
- [ ] [5.2] AC-11: Agent offline 12min — grayed card, "Last seen 12m ago" [owner:engineer]
- [ ] [5.3] AC-12: 92% disk — warning color gauge [owner:engineer]

## 6. Project ACs
- [ ] [6.1] AC-13: Project "co" — 2 sessions on 2 machines [owner:engineer]
- [ ] [6.2] AC-14: Click session from project view — streaming terminal opens [owner:engineer]

## 7. CI
- [ ] [7.1] Add CI pipeline configuration (run acceptance tests on push) [owner:engineer]
