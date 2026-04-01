/// Default port for the Nexus agent gRPC server.
pub const DEFAULT_GRPC_PORT: u16 = 7400;

/// Default port for the Nexus agent HTTP API.
pub const DEFAULT_HTTP_PORT: u16 = 7402;

/// Build the base URL for the local agent's HTTP API.
pub fn local_http_base_url(port: u16) -> String {
    format!("http://localhost:{port}")
}
