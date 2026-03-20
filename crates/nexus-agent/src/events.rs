use nexus_core::proto::SessionEvent;
use tokio::sync::broadcast;

/// Fan-out event broadcaster for session lifecycle events.
///
/// Wraps a `tokio::sync::broadcast` channel so multiple gRPC stream
/// subscribers can each receive a copy of every `SessionEvent` emitted
/// by the registry.
#[derive(Debug)]
pub struct EventBroadcaster {
    tx: broadcast::Sender<SessionEvent>,
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
        // send() returns Err when there are no active receivers — that is fine.
        let _ = self.tx.send(event);
    }

    /// Create a new receiver that will see all events emitted after this call.
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.tx.subscribe()
    }
}
