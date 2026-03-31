# Implementation Tasks

<!-- beads:epic:TBD -->

## Config Batch

- [ ] [1.1] [P-1] Add bind_address and secret fields to NexusConfig struct and agents.toml parsing [owner:engineer]
- [ ] [1.2] [P-1] Default bind_address to 127.0.0.1 when not specified [owner:engineer]
- [ ] [1.3] [P-2] Support NEXUS_SECRET environment variable override for shared secret [owner:engineer]

## API Batch

- [ ] [2.1] [P-1] Update main.rs to use configured bind_address for both HTTP and gRPC servers [owner:engineer]
- [ ] [2.2] [P-1] Add shared-secret auth middleware/extractor for /project/{code}/run endpoint [owner:engineer]
- [ ] [2.3] [P-2] Return 401 Unauthorized when secret is missing, invalid, or unconfigured [owner:engineer]

## Verification Batch

- [ ] [3.1] Test default bind to 127.0.0.1 when no bind_address configured [owner:engineer]
- [ ] [3.2] Test explicit bind_address override works for both servers [owner:engineer]
- [ ] [3.3] Test /run endpoint rejects requests without valid X-Nexus-Secret header [owner:engineer]
- [ ] [3.4] Test /run endpoint accepts requests with valid X-Nexus-Secret header [owner:engineer]
