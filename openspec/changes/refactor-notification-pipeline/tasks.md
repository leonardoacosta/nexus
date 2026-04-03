# Tasks: Separate Notification Channels

## Phase 1: Extract Channel Delivery from ReceiverService

- [ ] Create `notification_engine/banner.rs` — wraps `BannerDelivery::deliver()` (move from `delivery.rs`)
- [ ] Create `notification_engine/apns.rs` — wraps `ApnsClient::send_notification_ext()` (move from `delivery.rs`)
- [ ] Create `notification_engine/tts_handle.rs` — in-process handle to TtsService (replaces HTTP call)
- [ ] Move `meeting_queue.rs` from `services/receiver/` to `notification_engine/`
- [ ] Move `suppression.rs` from `services/receiver/` to `notification_engine/`

## Phase 2: Expand NotificationEngine

- [ ] Add `Deduplicator` to NotificationEngine (move from ReceiverState)
- [ ] Add mode checking logic (move from `http_router.rs` speak handler)
- [ ] Add channel routing logic: decide TTS vs Banner vs APNs per notification
- [ ] Integrate MeetingQueue into the engine's process() flow
- [ ] Wire banner + APNs as direct calls (no HTTP)
- [ ] Wire TTS via in-process handle (playback queue sender)

## Phase 3: Shrink ReceiverService → TtsService

- [ ] Rename `ReceiverService` → `TtsService`
- [ ] Remove channel routing from `http_router.rs` (keep only `/speak` for TTS)
- [ ] Remove banner delivery from TtsService
- [ ] Remove APNs delivery from TtsService
- [ ] Remove meeting queue from TtsService state
- [ ] Remove suppression checker from TtsService state
- [ ] Expose `PlaybackQueueHandle` for NotificationEngine to send TTS requests

## Phase 4: Eliminate HTTP Notification Relay

- [ ] Remove `relay_notification_to_peers()` from `socket.rs`
- [ ] Route all notification socket events through the lifecycle channel
- [ ] EventForwarder already streams lifecycle events — notifications ride the same channel
- [ ] Remove `peer_relay_urls` from `SocketContext`

## Phase 5: Wire + Test

- [ ] Update `main.rs`: construct TtsService, pass handle to NotificationEngine
- [ ] Update `main.rs`: remove ReceiverService construction for non-notifier roles
- [ ] Integration test: notification → banner delivery (no TTS involved)
- [ ] Integration test: notification → APNs delivery (no TTS involved)
- [ ] Integration test: meeting queue → summary → TTS + banner
- [ ] Integration test: remote event via gRPC → NotificationEngine → delivery
