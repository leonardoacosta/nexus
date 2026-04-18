# Implementation Tasks

<!-- beads:epic:nx-gvcj -->

## DB Batch

(none)

## API Batch

(none — no backend changes)

## UI Batch

- [x] [1.1] [P-1] Replace dangerouslySetInnerHTML at spec-events-subscriber.tsx:356 with sanitized rendering (DOMPurify or markdown-it sanitize) [owner:ui-engineer] [beads:nx-jgy0]
- [x] [1.2] [P-1] Wrap fetch at spec-events-subscriber.tsx:252 in AbortController; abort in useEffect cleanup [owner:ui-engineer] [beads:nx-ow64]
- [x] [1.3] [P-1] Wrap EventSource/SSE subscription in AbortController equivalent (eventSource.close in cleanup) [owner:ui-engineer] [beads:nx-dsqn]
- [x] [1.4] [P-2] Extract transport (fetch + EventSource) into apps/nextjs/src/app/specs/spec-events-transport.ts [owner:ui-engineer] [beads:nx-nfa6]
- [x] [1.5] [P-2] Extract event parsing/coalescing into apps/nextjs/src/app/specs/spec-events-parser.ts [owner:ui-engineer] [beads:nx-f100]
- [x] [1.6] [P-2] Reduce spec-events-subscriber.tsx to rendering only (<250 lines) [owner:ui-engineer] [beads:nx-h8vq]
- [x] [1.7] [P-3] If split-core-browser-barrel landed, delete duplicated SpecTransitionEvent/SpecEventsFrame types and import from @nexus/core [owner:ui-engineer] [beads:nx-djo3]

## E2E Batch

- [ ] [2.1] Add Playwright test asserting <script>...</script> in spec content does not execute [owner:e2e-engineer] [beads:nx-99kt]
- [ ] [2.2] Add unit test asserting fetch is aborted when component unmounts mid-request [owner:e2e-engineer] [beads:nx-zdim]
