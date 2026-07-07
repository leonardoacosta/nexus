# Add Capture Proxy + Shortcut

## Why

Companion to mx add-capture-source: the phone's narrow job is capture +
glance. The pilot capture surface is deliberately zero-Swift — an Apple
Shortcut (share-sheet enabled) posting to nexus-agent over Tailscale, which
proxies to the mx gateway. No app build, no App Store, ships in an afternoon;
a native share extension is post-gate polish if the Shortcut proves sticky.

## What Changes

- Agent `POST /capture` passthrough to the mx gateway. Write posture (same as
  the decision route): NOT fail-soft — 4xx/5xx propagate verbatim, timeout
  maps to 504. A capture that silently vanishes is worse than one that
  visibly fails; the Shortcut shows the error and the thought stays in hand.
- `docs/capture-shortcut.md`: the Shortcut recipe — share-sheet + manual
  invocation, title from input/prompt, url auto-filled from shared page,
  agent URL + auth header over Tailscale, success/failure banners.

## Non-Goals

- No native iOS share extension, no offline queue (the Shortcut fails loudly;
  retry is a re-tap).
- No capture UI in nexus-mac/nexus-ios.

## Impact

- Affected specs: new capability `capture-intake`.
- Affected code: `apps/agent/src/routes/capture.ts`, docs.
- Depends on: mx add-capture-source.

## Testing

- Route vitest: body passthrough, verbatim 400/5xx, 504 on timeout, auth
  middleware applied.
- [user] End-to-end from the phone: share a page + capture a bare thought via
  the Shortcut; paste the created request ids and the failure banner behavior
  with the agent stopped.
