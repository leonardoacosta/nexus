use std::sync::Arc;

use nexus_core::proto::SessionEvent;
use tokio::sync::broadcast;

/// Fan-out event broadcaster for session lifecycle events.
///
/// Wraps a `tokio::sync::broadcast` channel so multiple gRPC stream
/// subscribers can each receive a copy of every `SessionEvent` emitted
/// by the registry. Events are wrapped in `Arc` so the message body is
/// not cloned for each subscriber — only the pointer is.
#[derive(Debug)]
pub struct EventBroadcaster {
    tx: broadcast::Sender<Arc<SessionEvent>>,
}

impl EventBroadcaster {
    /// Create a new broadcaster with the given channel capacity.
    ///
    /// When a slow receiver falls behind by more than `capacity` messages it
    /// will receive a `Lagged` error and skip the missed events.
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    /// Emit an event to all active subscribers.
    ///
    /// If there are no subscribers the event is silently dropped (inherent
    /// broadcast channel behaviour). A `SendError` only occurs when the
    /// receiver count is zero, which is not an error condition for us.
    pub fn emit(&self, event: SessionEvent) {
        let receiver_count = self.tx.receiver_count();
        let payload_type = match &event.payload {
            Some(nexus_core::proto::session_event::Payload::Started(_)) => "Started",
            Some(nexus_core::proto::session_event::Payload::Heartbeat(_)) => "Heartbeat",
            Some(nexus_core::proto::session_event::Payload::StatusChanged(_)) => "StatusChanged",
            Some(nexus_core::proto::session_event::Payload::Stopped(_)) => "Stopped",
            Some(nexus_core::proto::session_event::Payload::GoingAway(_)) => "GoingAway",
            None => "None",
        };
        tracing::debug!(
            session_id = %event.session_id,
            payload_type,
            receiver_count,
            "event: emitting"
        );
        // Wrap in Arc once; each subscriber receives a clone of the pointer only.
        // send() returns Err when there are no active receivers — that is fine.
        let _ = self.tx.send(Arc::new(event));
    }

    /// Create a new receiver that will see all events emitted after this call.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<SessionEvent>> {
        self.tx.subscribe()
    }
}
