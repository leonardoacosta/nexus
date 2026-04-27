# Implementation Tasks

> **Depends on:** `restore-tts-mac-audio-dispatch` (audio pipeline must be live before settings can gate it meaningfully).

## DB Batch

- [x] [1.1] [P-1] Create `packages/db/src/schema/notification-settings.ts` — Drizzle schema for `notification_settings` table with columns `id, tts_enabled, banner_enabled, ducking_mode, updated_at`. [owner:db-engineer]
- [x] [1.2] [P-1] Generate migration via `bun drizzle-kit generate`; inspect output; add a bootstrap INSERT for the `id=1` row with defaults `(true, true, 'full')`. [owner:db-engineer]
- [x] [1.3] [P-2] Re-export `notificationSettings` from `packages/db/src/index.ts` so Next.js and the agent consume the same type via `@nexus/db`. [owner:db-engineer]

## API Batch (agent, TypeScript)

- [x] [2.1] [P-1] Create `apps/agent/src/routes/notification-settings.ts` with `handleGetNotificationSettings` and `handlePatchNotificationSettings` handlers. GET returns the `id=1` row. PATCH validates incoming JSON (allow-list `tts_enabled`, `banner_enabled`, `ducking_mode`), runs UPDATE, returns refreshed row. Both handlers require the `x-nexus-secret` header (reuse `requireSecret`). [owner:api-engineer]
- [x] [2.2] [P-1] In `apps/agent/src/routes/notifications-builder.ts`, register `GET /notifications/settings` and `PATCH /notifications/settings` routes. [owner:api-engineer]
- [x] [2.3] [P-1] In `apps/agent/src/services/lifecycle-bus.ts`, add `SettingsChangedPayload` type and extend `LifecycleEventMap` with the `SettingsChanged` variant. [owner:api-engineer]
- [x] [2.4] [P-1] In the PATCH handler, after DB update, emit `lifecycleBus.emit("SettingsChanged", {ttsEnabled, bannerEnabled, duckingMode})`. [owner:api-engineer]
- [x] [2.5] [P-2] Write unit tests — PATCH validates `ducking_mode` enum, rejects unknown fields, reads/writes the single-row table correctly. [owner:e2e-engineer]

## Dashboard Batch (Next.js)

- [x] [3.1] [P-1] Create `apps/nextjs/app/notifications/page.tsx` — server component that fetches initial settings and last 50 notification rows via the agent HTTP API, hydrates to the client component. [owner:ui-engineer]
- [x] [3.2] [P-1] Create `apps/nextjs/app/notifications/NotificationsClient.tsx` — client component rendering: (a) settings strip with three controls (Switch × 2 + RadioGroup × 1) — use existing shadcn primitives; (b) notifications table with compact row density (≤ 40px) and columns `Time | Channel | Project | Title | Body | Status | ▶`. [owner:ui-engineer]
- [x] [3.3] [P-1] Wire toggle mutations → PATCH `/notifications/settings` with optimistic UI via `useOptimistic` (React 19) or equivalent; roll back on non-2xx with a toast. [owner:ui-engineer]
- [x] [3.4] [P-1] Subscribe to `/events/stream` SSE in the client component; filter for `NotificationFired` envelopes; prepend to the table state. Cap the in-memory list at 200 entries (drop oldest). [owner:ui-engineer]
- [x] [3.5] [P-1] Replay button (`▶`) — POSTs a duplicate notification via `/notifications/send` with a fresh id. Disabled for `suppressed` / `expired` rows. [owner:ui-engineer]
- [x] [3.6] [P-2] Add `/notifications` to the dashboard navigation (sidebar or top-nav, whichever matches current UX). [owner:ui-engineer]
- [x] [3.7] [P-2] Layout constraints: settings strip ≤ 120px height; no modals; no full-page takeover. Verify on a 1280×800 MacBook display. [owner:ux-specialist]

## Mac Listener Batch (bash)

- [x] [4.1] [P-1] Extend `deploy/mac/nexus-notifier.sh` — on startup, GET `/notifications/settings`; cache into shell vars `$TTS_ENABLED`, `$BANNER_ENABLED`, `$DUCKING_MODE`. Fall back to `true/true/full` on 404 (first-install tolerance). [owner:devops-engineer]
- [x] [4.2] [P-1] In the SSE reader loop, handle `event: SettingsChanged` frames by updating cached vars. No listener restart required. [owner:devops-engineer]
- [x] [4.3] [P-1] Guard `_dispatch_tts` — skip playback when `TTS_ENABLED=false`. [owner:devops-engineer]
- [x] [4.4] [P-1] Guard `_dispatch_banner` — skip when `BANNER_ENABLED=false`. [owner:devops-engineer]
- [x] [4.5] [P-1] Add `_apply_ducking` helper — before `afplay`, if `DUCKING_MODE=half`: save current system volume, set to 25%, set a trap to restore on completion. If `DUCKING_MODE=mute`: save mute state, mute, restore. If `full`: noop. [owner:devops-engineer]
- [x] [4.6] [P-2] Log every suppressed event (TTS-suppressed, banner-suppressed) to `nexus-notifier.log` so the dashboard table entry can be cross-referenced with "listener saw it but suppressed due to settings". [owner:devops-engineer]

## Validation Batch

- [ ] [5.1] [P-1] [user] End-to-end test — toggle TTS off in dashboard; fire a notification; assert the Mac log shows `tts suppressed`, DB row status is `delivered`, banner still fires (if banner_enabled). Requires Leo's Mac running the listener live; cannot complete autonomously. [owner:e2e-engineer]
- [ ] [5.2] [P-1] [user] End-to-end test — set ducking to `half`; fire a notification while music is playing; manual check that music ducks during playback and restores after. Requires Leo's Mac running the listener live; cannot complete autonomously. [owner:e2e-engineer]
- [ ] [5.3] [P-2] [user] Dashboard screenshot — capture the `/notifications` page at rest and with 5+ rows; attach to `docs/screenshots/notifications-page.png` for archival. Requires the dashboard running with seeded rows. [owner:ux-specialist]
