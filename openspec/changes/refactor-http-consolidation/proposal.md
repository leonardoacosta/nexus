# Proposal: Consolidate HTTP Servers

**Change ID:** `refactor-http-consolidation`
**Status:** Draft
**Priority:** P2 — depends on `refactor-notification-pipeline`

## Problem

The primary agent runs two separate axum HTTP servers:
- **:7402** — 25+ REST endpoints (health, specs, credentials, events, project status, commands, analytics)
- **:9999** — ReceiverService with its own router, state, and lifecycle (/speak, /health, /history, /mode, /play)

Two axum instances means two bind addresses, two shutdown lifecycles, two sets of middleware. Port 9999 is an extra surface to firewall and document. Remote agents must know about a separate port for notification relay.

## Solution

Merge ReceiverService's routes into the main HTTP server on :7402. After `refactor-notification-pipeline` shrinks ReceiverService to TtsService (audio only), the remaining HTTP surface is small:

- `POST /speak` — TTS-only endpoint (used by NotificationEngine in-process, exposed for debugging)
- `GET /notifications/mode` — query current mode
- `PUT /notifications/mode` — set mode
- `GET /notifications/history` — recent notification history
- `GET /notifications/meeting` — meeting queue status

These fold naturally into the existing :7402 router under a `/notifications` prefix.

## Key Design Decisions

### Notification Config Endpoints
With NotificationEngine on the Mac only, the HTTP server should expose config management:
- `GET /notifications/rules` — per-project notification rules
- `PUT /notifications/rules/:project` — update a project's rules
- `GET /notifications/config` — full notification config

These replace the socket commands `notification_rules` and `notification_set`.

### TtsService Becomes Library-Only
TtsService no longer runs its own HTTP listener. It's an in-process struct owned by NotificationEngine. The `/speak` endpoint on :7402 delegates to it (for debugging/testing), but TtsService itself has no network surface.

### Single Port per Agent
After this change, every agent exposes exactly:
- **:7400** — gRPC (tonic)
- **:7402** — HTTP (axum)
- **sock** — Unix domain socket

No role-specific ports. The datastore exposes `/ingest` on :7402. The notifier exposes `/notifications/*` on :7402. Same port, different routes.

## Impact

| Component | Change |
|---|---|
| `services/receiver/service.rs` | Remove `start()` HTTP listener, becomes struct-only |
| `services/receiver/http_router.rs` | Move notification routes to main HTTP router |
| `main.rs` | Remove `spawn_service(receiver)`, mount notification routes on :7402 |
| `http_handlers.rs` | Add `/notifications/*` handlers |
| `socket.rs` | Update relay URL from `:9999` to `:7402/speak` (transitional) |

## Dependencies
- Requires `refactor-notification-pipeline` to be completed first (shrinks ReceiverService to TtsService)
- Works well with `refactor-central-db` (datastore's `/ingest` and notifier's `/notifications/*` both on :7402)
