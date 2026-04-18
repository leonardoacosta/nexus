# Proposal: Harden spec-events-subscriber (XSS, fetch lifecycle, module split)

## Change ID
`harden-spec-events-subscriber`

## Summary
Eliminate the `dangerouslySetInnerHTML` XSS sink in `apps/nextjs/src/app/specs/spec-events-subscriber.tsx`, wrap every fetch and `EventSource` subscription in an `AbortController`-equivalent that is torn down on unmount, and split the 571-line file into separate transport, parsing, and rendering modules. The split is what makes the security fix permanent: the rendering module becomes small enough to review for unsafe sinks at a glance.

## Context
- Lives in `apps/nextjs/src/app/specs/spec-events-subscriber.tsx` (Next.js App Router, `"use client"` component).
- Origin spec: `openspec/changes/archive/2026-04-18-add-spec-page-live-updates/proposal.md` introduced this component as the SSE subscriber for `/specs/events`. SSE protocol (event name `spec-transition`, `SpecEventsFrame` payload, exponential backoff 1s→30s, refetch-on-reconnect) is unchanged.
- Related (active): `openspec/changes/split-core-browser-barrel/` — once that lands, the duplicated `SpecTransitionEvent` and `SpecEventsFrame` types in this file (lines 25-48) can be deleted and re-imported from `@nexus/core`. This proposal can land independently, but is cleanest if sequenced **after** `split-core-browser-barrel` so task 1.7 here merges with task 2.1 there.
- Audit findings driving this proposal (all in the same file, 2026-04-08 wave):
  - **D5** (error, security): line 356 `dangerouslySetInnerHTML` — the only error-severity security finding in the wave.
  - **E7** (error, performance): line 252 `fetch()` with no `AbortController` / signal — leaks request on unmount, no timeout, accumulates on hot-reload.
  - **B4** (warning, architecture): 571 lines mixing transport (SSE + fetch), parsing/validation, state folding, and rendering in one file.

## Motivation
The XSS sink is a real regression in a security-conscious codebase: spec event content originates from the agent over the network, and any future change that lets that content reach the `<style>` block or another `dangerouslySetInnerHTML` site renders arbitrary script with the page's origin. Today the injected payload is a static CSS string controlled by the component itself, but the pattern is fragile — a single contributor wiring spec text into a `dangerouslySetInnerHTML` would create a stored XSS without any compile-time signal.

Leaked fetches are an everyday papercut in dev: each Fast Refresh remount issues a new `/specs/all` request without aborting the prior one. Production isn't immune either — operators leaving the tab open during agent restarts produce a steady drip of in-flight aborted-by-error responses that spam React with "set state on unmounted component" warnings.

The 571-line file is the structural reason the first two issues are easy to introduce and hard to spot. Transport (EventSource, fetch, backoff timers), validation (`parseSpecEventsFrame`), state folding (`applyTransition`, highlight bookkeeping), and rendering (table, indicator, scoped CSS) all share the same module scope. A reviewer cannot tell at a glance which lines touch network, which touch DOM, or where untrusted input enters the render path. Splitting reduces the rendering surface to ~200 lines that can be audited for sinks in one read.

## Requirements

### Requirement: No `dangerouslySetInnerHTML` in the rendering module
The rendering module (the file containing `SpecEventsSubscriber`) MUST NOT use `dangerouslySetInnerHTML`. The scoped-CSS block currently injected via `dangerouslySetInnerHTML` SHALL be moved to a static CSS module, a `styled-jsx` block, or a top-level `<style>` element with literal children — none of which evaluate runtime strings as HTML. If a future requirement forces rendering of untrusted markup, it MUST go through a sanitizer (DOMPurify or `markdown-it` with HTML disabled) on an explicit allowlist; raw `dangerouslySetInnerHTML` calls remain banned.

### Requirement: All fetch and SSE subscriptions are tied to component lifetime
Every `fetch()` call MUST be wrapped in an `AbortController` whose `signal` is passed to `fetch`, and `controller.abort()` MUST be invoked from the `useEffect` cleanup function. Every `EventSource` instance MUST be `.close()`d from the same cleanup function. The `AbortController` MUST be scoped to the component's lifetime (one per mounted instance), not per render — re-renders SHALL NOT abort in-flight legitimate responses.

### Requirement: Transport, parsing, and rendering live in separate modules
The SSE/fetch transport (EventSource construction, backoff loop, reconnect timers, refetch-all logic) MUST live in `apps/nextjs/src/app/specs/spec-events-transport.ts`. The frame validation and state-folding logic (`parseSpecEventsFrame`, `applyTransition`, `specKey`) MUST live in `apps/nextjs/src/app/specs/spec-events-parser.ts`. The rendering module (`spec-events-subscriber.tsx`) MUST NOT exceed 250 lines and MUST contain only React component code, JSX, and the hook that wires transport state into the rendered table.

## Scope
- **IN**: Hardening `apps/nextjs/src/app/specs/spec-events-subscriber.tsx`; extracting transport and parser modules under `apps/nextjs/src/app/specs/`; removing the `dangerouslySetInnerHTML` block; adding `AbortController` to `refetchAll` and any other future fetches; tests asserting the security and lifecycle invariants.
- **OUT**: Changes to the SSE wire protocol (event name, frame shape, backoff schedule); backend changes in `apps/agent/`; visual redesign of the specs table or `LiveIndicator`; introducing a markdown renderer (no current spec event carries HTML content); migrating to a query library.

## Impact
| Area | Change |
|------|--------|
| `apps/nextjs/src/app/specs/spec-events-subscriber.tsx` | Reduced from 571 to <250 lines; rendering only; no `dangerouslySetInnerHTML`; consumes hook from new transport module |
| `apps/nextjs/src/app/specs/spec-events-transport.ts` | New file — `EventSource` lifecycle, backoff loop, `AbortController`-wrapped `refetchAll`, exposes `useSpecEventsStream` hook returning `{projects, status}` |
| `apps/nextjs/src/app/specs/spec-events-parser.ts` | New file — `parseSpecEventsFrame`, `applyTransition`, `specKey`, `SPEC_EVENTS_EVENT_NAME` |
| `apps/nextjs/src/app/specs/spec-events-styles.module.css` (or equivalent) | New file or `<style>` literal — replaces the `dangerouslySetInnerHTML` CSS injection |
| Optional dep | DOMPurify only added if a future requirement forces HTML rendering; not added in this change |

## Risks
| Risk | Mitigation |
|------|-----------|
| CSS module / `styled-jsx` migration changes specificity and the highlight no longer animates | Visual regression check + Playwright assertion that a row gains the `spec-row-changed` class on a synthetic event |
| `AbortController` scoped wrong (per render instead of per mount) aborts a legitimate in-flight refetch | Controller created inside `useEffect(() => { ... }, [agentBaseUrl, ...])` and stored in a ref; cleanup aborts only when deps change or component unmounts; covered by the unmount-mid-request unit test |
| Splitting introduces a circular import between transport and parser | Parser depends only on types from `./types`; transport imports parser; rendering imports transport's hook — strict one-direction dependency, enforced by ESLint `import/no-cycle` |
| Splitting drops the JSDoc context block at the top of the original file | Preserve the block as a header comment in the new transport module (it documents reconnect strategy + state handling, both of which live there) |
| Sanitization, if added later, strips legitimate markup operators expect to see | Allowlist test cases enumerated alongside the sanitizer call site; out of scope for this change since no spec event currently carries HTML |
