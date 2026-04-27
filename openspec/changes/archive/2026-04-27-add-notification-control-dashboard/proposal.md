# add-notification-control-dashboard — Change Proposal

## Summary

Add a `/notifications` page to the nexus-dashboard Next.js app with two components laid out as non-intrusive elements on a single scrollable page: (1) a compact settings strip exposing toggles for TTS on/off, audio ducking mode (full / half / mute), and banners on/off; and (2) a table of recent notifications (timestamp, channel, project, title, body, delivery status, replay button). Persist settings to a new `notification_settings` row, expose GET/PATCH endpoints on the nexus-agent HTTP API, broadcast mutations via `lifecycleBus.emit("SettingsChanged", …)`, and have the Mac-side listener subscribe so toggle changes propagate in near-real-time.

## Motivation

**Observed (2026-04-24):** After the TTS pipeline was restored end-to-end (see `restore-tts-mac-audio-dispatch`), the user has no runtime control over notification behavior. Every TTS notification plays at full volume over whatever audio is currently active, every banner fires regardless of meeting state, and there is no way to audit which notifications fired today without SSH'ing to the Mac to `tail ~/Library/Logs/nexus-notifier.log`.

**Specific friction:**

- Playing TTS during a video call is disruptive (no ducking)
- Toggling TTS off for focus sessions requires editing the launchd plist and restarting the listener
- Toggling banners off for demos / screen-sharing requires the same dance
- "Did that notification fire?" requires three separate log tails (agent, socket dispatcher, Mac listener)

**Existing infrastructure the change leans on:**

- `notifications` table (from `notification-store` capability) already persists every notification with id, channel, title, body, project, status, created_at, sent_at
- `meeting-state.ts` already captures a boolean meeting-active state — the new ducking mode is the user-driven counterpart to that auto-buffer logic
- `nexus-dashboard` (port 3100) already renders a React app served from `apps/nextjs/`
- `lifecycleBus` already supports subscriber patterns for the Mac listener to pick up `SettingsChanged` events

## Requirements (ADDED)

### Notification settings schema MUST be persistent

A new DB table `notification_settings` MUST exist with a single-row semantic (or `id = 1` sentinel) storing the current runtime settings:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| id | int | 1 | Single-row sentinel |
| tts_enabled | boolean | true | Mac listener plays audio when true |
| banner_enabled | boolean | true | Mac listener fires osascript banner when true |
| ducking_mode | enum(`full`,`half`,`mute`) | `full` | How other-app audio should respond during TTS playback |
| updated_at | timestamp | now | Last mutation time |

`full` = no change to other-app audio. `half` = reduce other-app system volume by ~50% during TTS playback, restore on completion. `mute` = fully mute other-app output during playback.

### GET /notifications/settings MUST return current state

A GET endpoint at `/notifications/settings` MUST return the single-row settings as JSON. It MUST require the standard `x-nexus-secret` auth header.

### PATCH /notifications/settings MUST update persisted state AND broadcast

A PATCH endpoint at `/notifications/settings` MUST accept a partial JSON object with any subset of `{ tts_enabled, banner_enabled, ducking_mode }`. Unmentioned fields remain unchanged. The endpoint MUST:
- Persist the partial update
- Update `updated_at`
- Emit `lifecycleBus.emit("SettingsChanged", {settings})` with the post-update values
- Return the full current state as JSON

### SettingsChanged lifecycle event MUST be a new bus type

`LifecycleEventMap` MUST gain a `SettingsChanged` variant with payload `{ ttsEnabled: boolean; bannerEnabled: boolean; duckingMode: "full" | "half" | "mute" }`. Existing SSE subscribers on `/events/stream` MUST receive this event via the wildcard dispatcher without code changes.

### Mac listener MUST honor settings

The Mac-side listener (`deploy/mac/nexus-notifier.sh`) MUST:
- On startup, GET `/notifications/settings` and cache values in shell variables
- Subscribe to `SettingsChanged` SSE events and update the cached values on receipt
- Skip `afplay` dispatch when `tts_enabled=false`
- Skip `osascript display notification` when `banner_enabled=false`
- Before each `afplay`, apply the current `ducking_mode`:
  - `full` — no change
  - `half` — `osascript -e 'set volume output volume 25'` (or equivalent); restore on afplay completion
  - `mute` — `osascript -e 'set volume with output muted'`; restore on completion

Notifications still persist to the DB regardless of toggle state — the user can see them in the table even if audio/banner was suppressed at the time.

### Dashboard MUST render /notifications page

A new route at `/notifications` in `apps/nextjs` MUST render a single-scroll page with two components:

**Settings strip (top, non-intrusive):** A horizontal card ≤ 120px tall containing three controls:
- TTS toggle (switch, label "TTS")
- Banners toggle (switch, label "Banners")
- Ducking radio group (3 options: Full / Half / Mute, default Full)

Toggle mutations MUST call PATCH `/notifications/settings` and optimistically update the UI. Failure MUST surface as a toast (or equivalent non-blocking indicator) and roll back the optimistic update.

**Notifications table (below):** Columns: `Time | Channel | Project | Title | Body | Status | ▶`. Rows sorted by created_at desc, paginated at 50/page. Row density MUST be compact (≤ 40px per row). The replay button (`▶`) MUST POST a duplicate notification (new id, same title/body/channel/project) via the existing `/notifications/send` endpoint. Delivery status badges: `delivered` (green), `queued` (yellow), `expired` (gray), `failed` (red).

The page MUST subscribe to `/events/stream` and prepend newly-arrived `NotificationFired` envelopes to the top of the table without a full refetch.

### Settings controls MUST be non-intrusive

"Non-intrusive" means: no modal, no full-page takeover, no red-outlined warning states. Control-strip height ≤ 120px. Toggle interactions MUST debounce at ≥ 250ms. Ducking-mode changes MUST NOT trigger any audio playback as a preview — the change applies on the next real notification only.

## Scope

**IN:**
- `packages/db/src/schema/notification-settings.ts` — new Drizzle schema for `notification_settings` table
- `packages/db/migrations/<N>-notification-settings.sql` — migration creating table + inserting `id=1` sentinel row with defaults
- `apps/agent/src/routes/notification-settings.ts` — new file implementing GET/PATCH handlers
- `apps/agent/src/routes/notifications-builder.ts` — register the two new routes
- `apps/agent/src/services/lifecycle-bus.ts` — add `SettingsChanged` event + payload type
- `deploy/mac/nexus-notifier.sh` — extend with settings fetch on startup + SSE subscribe for `SettingsChanged` + ducking logic
- `apps/nextjs/app/notifications/page.tsx` — new page (server component shell)
- `apps/nextjs/app/notifications/NotificationsClient.tsx` — client component rendering the strip + table + live SSE subscription
- Dashboard navigation (sidebar / top bar) MUST include a link to `/notifications` as a peer of existing pages

**OUT:**
- Per-project settings (global toggles only; per-project routing rules already exist in `projectRules` for a different purpose and are separately configured)
- Do-not-disturb schedule / time-based rules (meeting-state already handles active-meeting detection via `meeting-state.ts`)
- Slack channel settings (Slack already has its own webhook config; this proposal scope is desktop + TTS audible channels)
- Audio volume level beyond three-state ducking (no slider — keeps the strip compact and decisions atomic)
- Replay audit trail (replay generates a new notification row like any other; not tagged as a replay)
- Sound preview / test button — would require firing a real ElevenLabs call, spending quota; defer
- Multi-Mac fanout (today there is one Mac listener; multi-listener config moves to a follow-up)

## Impact

- **Behavioral:** User gains three always-available toggles controlling a critical noise source. No default behavior change when settings are unchanged (defaults of `true`, `true`, `full` match today's behavior).
- **Wire:** +1 HTTP GET per listener startup. +1 HTTP PATCH per user toggle. +1 small SSE event per settings mutation. Audio ducking adds 2 osascript calls per TTS notification (pre + post).
- **DB:** +1 table (`notification_settings`), +1 migration. Table holds ≤ 1 row by design — storage overhead is nil.
- **Security:** Existing `x-nexus-secret` auth gate applies to both new endpoints. No new secret surface.
- **Rollback:** Deleting the new routes + page leaves the Mac listener with a cached "defaults" state (it fetches settings at startup and falls back to hardcoded `tts=true, banner=true, ducking=full` on 404). Settings table can remain orphaned or be dropped via follow-up migration.
