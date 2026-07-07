# Tasks — add-attention-guard

## UI Batch

- [x] 1.1 Cached queue-head fetch in nexus-statusline following the getRoadmapPulse() SWR shape (searched: apps/nexus-statusline/src/index.ts getRoadmapPulse is the cache/refresh exemplar; reuse, no new cache layer)
  - touches: apps/nexus-statusline/src/
- [x] 1.2 Drift line render: foreign-project + preempt/high-confidence gate, single line, silent on all other states incl. fetch failure; project-context match from the statusline's cwd/project input
  - depends on: 1.1
  - touches: apps/nexus-statusline/src/
- [x] 1.3 Session clock render: elapsed from session start, plain text, no thresholds/escalation
  - touches: apps/nexus-statusline/src/
- [x] 1.4 Unit tests: drift matrix (foreign-preempt renders; same-project/low-confidence/empty/failure silent), clock formatting across boundaries
  - depends on: 1.2, 1.3
  - touches: apps/nexus-statusline/src/

## E2E Batch

- [x] 2.1 Runtime evidence: paste statusline output from a session with a planted foreign preempt head, and from a healthy session showing silence + the clock
  - depends on: 1.4
