pub mod agent;
pub mod command;
pub mod config;
pub mod credentials;
pub mod db;
pub mod health;
pub mod lifecycle;
pub mod notes;
pub mod paths;
pub mod ports;
pub mod project_registry;
pub mod proto_convert;
pub mod session;
pub mod socket_event;

pub use ports::{DEFAULT_GRPC_PORT, DEFAULT_HTTP_PORT, local_http_base_url};

/// Generated protobuf types and gRPC service stubs for the Nexus agent API.
#[allow(clippy::large_enum_variant)]
pub mod proto {
    tonic::include_proto!("nexus.v1");
}
