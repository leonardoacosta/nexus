# Proposal: Separate Notification Channels

**Change ID:** `refactor-notification-pipeline`
**Status:** Draft
**Priority:** P1 — highest-impact architectural fix

## Problem

The `ReceiverService` (20 files, 8.1K lines) acts as both a TTS audio engine AND a notification orchestrator. It owns channel routing, meeting detection, deduplication, banner delivery, APNs push, and TTS playback — all funneled through a single `/speak` HTTP endpoint. The `NotificationEngine` is a thin pipe that calls `receiver.speak_from_socket()` without any channel awareness.

This is backwards. Banner delivery and APNs push are fire-and-forget HTTP calls that don't need the serial playback queue, media ducking, or dedup logic that TTS requires. The meeting queue (a notification-level concern) lives inside ReceiverState (a TTS-level struct).

## Solution

**NotificationEngine becomes the single orchestrator.** It owns:
- Per-project rules
- Deduplication
- Mode checking (Full / NoDuck / System / Silent)
- Meeting detection + queue
- Channel routing decision
- Banner delivery (direct — terminal-notifier is fire-and-forget)
- APNs delivery (direct — HTTP/2 push is fire-and-forget)
- TTS forwarding → sends to TtsService

**ReceiverService becomes TtsService.** It owns only:
- TTS playback queue (serial, batched)
- ElevenLabs API calls
- System TTS fallback (macOS `say`)
- Media ducking
- Audio file playback

## Architecture

```
Before:
  Event → NotificationEngine.deliver()
        → ReceiverService.speak_from_socket() [HTTP /speak]
        → http_router: dedup → mode → meeting → channel route
          → TTS (playback queue)
          → Banner (tokio::spawn inside HTTP handler)
          → APNs (tokio::spawn inside HTTP handler)

After:
  Event → NotificationEngine.process()
        → dedup → mode → meeting check
        → channel routing:
          ├── Banner → BannerDelivery::deliver() (direct call)
          ├── APNs → ApnsClient::send() (direct call)
          └── TTS → TtsService.speak() (in-process call, no HTTP)
```

## Key Design Decisions

### No HTTP between NotificationEngine and TtsService
Currently the engine calls the receiver via HTTP (`speak_from_socket` → internal HTTP POST). The TtsService should be an in-process struct with a `speak(&self, request)` method. No network round-trip for local audio playback.

### Remote Agent Relay
Remote agents currently relay to `primary:9999/speak`. With this change, they should relay lifecycle events via gRPC `StreamEvents` (already exists via EventForwarder). The NotificationEngine on the Mac receives these events and handles them. No separate HTTP relay needed for notifications.

### Meeting Queue Moves to NotificationEngine
The `MeetingQueue` is a notification-level concern — it decides whether to hold or deliver. It belongs in NotificationEngine, not in ReceiverState/TtsService.

### Dedup + Mode Move to NotificationEngine
Currently duplicated: NotificationEngine has per-project rules, AND ReceiverService has its own dedup + mode checks. Consolidate into NotificationEngine.

## Impact

| Component | Change |
|---|---|
| `notification_engine.rs` | Expands: owns dedup, mode, meeting queue, banner, APNs, channel routing |
| `services/receiver/` | Shrinks to TtsService: playback queue, ElevenLabs, system TTS, ducking |
| `services/receiver/http_router.rs` | Remove channel routing, meeting detection, banner/APNs dispatch |
| `services/receiver/meeting_queue.rs` | Move to `notification_engine/meeting_queue.rs` |
| `services/receiver/suppression.rs` | Move to `notification_engine/suppression.rs` |
| `services/receiver/delivery.rs` | Split: banner + APNs → NotificationEngine, TTS methods stay |
| `socket.rs` | Remove `relay_notification_to_peers()`, use lifecycle channel instead |
| `main.rs` | Wire TtsService as a dependency of NotificationEngine |

## Out of Scope
- Changing the ElevenLabs integration
- Changing the playback queue behavior
- Adding new notification channels
