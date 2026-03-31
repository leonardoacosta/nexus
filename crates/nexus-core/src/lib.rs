pub mod agent;
pub mod credentials;
pub mod command;
pub mod config;
pub mod health;
pub mod lifecycle;
pub mod notes;
pub mod paths;
pub mod project_registry;
pub mod proto_convert;
pub mod session;
pub mod socket_event;

/// Generated protobuf types and gRPC service stubs for the Nexus agent API.
#[allow(clippy::large_enum_variant)]
pub mod proto {
    tonic::include_proto!("nexus.v1");
}
