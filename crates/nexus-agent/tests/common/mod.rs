use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use nexus_core::proto::nexus_agent_client::NexusAgentClient;
use nexus_core::proto::nexus_agent_server::NexusAgentServer;
use tonic::transport::{Channel, Endpoint, Server};

// We need to reference internal crate types. Because integration tests are
// separate compilation units, we re-create the same dependency graph that
// main.rs uses rather than importing private modules.

use nexus_agent::events::EventBroadcaster;
use nexus_agent::health::HealthCollector;
use nexus_agent::registry::SessionRegistry;
use nexus_agent::shutdown::ShutdownCoordinator;
use nexus_agent::grpc::NexusAgentService;

/// Spin up a real `NexusAgentService` bound to a random OS-assigned port.
///
/// Returns the bound `SocketAddr`. The server runs in a background task for
/// the duration of the test process; it is dropped when the test binary exits.
pub async fn start_test_server() -> SocketAddr {
    // Build the same dependency graph as main.rs.
    let broadcaster = Arc::new(EventBroadcaster::new(256));
    let registry = Arc::new(SessionRegistry::new(Arc::clone(&broadcaster)));
    let health = HealthCollector::spawn(Duration::from_secs(60)); // long interval — tests don't need refreshes
    let coordinator = Arc::new(ShutdownCoordinator::new());

    let service = NexusAgentService::new(
        Arc::clone(&registry),
        Arc::clone(&broadcaster),
        health,
        "test-agent".to_string(),
        "localhost".to_string(),
        Arc::clone(&coordinator),
    );

    // Bind to port 0 — the OS picks a free port.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind test listener");
    let addr = listener.local_addr().expect("failed to get local addr");

    tokio::spawn(async move {
        Server::builder()
            .add_service(NexusAgentServer::new(service))
            .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener))
            .await
            .expect("test gRPC server failed");
    });

    addr
}

/// Create a `NexusAgentClient` connected to the given test server address.
pub async fn create_test_client(addr: SocketAddr) -> NexusAgentClient<Channel> {
    let endpoint = format!("http://{addr}");
    let channel = Endpoint::from_shared(endpoint)
        .expect("invalid endpoint")
        .connect()
        .await
        .expect("failed to connect to test server");
    NexusAgentClient::new(channel)
}
