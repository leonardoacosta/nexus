pub mod agent;
pub mod api;
pub mod config;
pub mod health;
pub mod lifecycle;
pub mod notification_config;
pub mod notes;
pub mod session;
pub mod socket_event;

/// Generated protobuf types and gRPC service stubs for the Nexus agent API.
#[allow(clippy::large_enum_variant)]
pub mod proto {
    tonic::include_proto!("nexus.v1");
}
