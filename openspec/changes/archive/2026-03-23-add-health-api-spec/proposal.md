# Change: Spec Health Monitoring API

## Why
The `GetHealth` RPC exists and works, but `uptime_seconds` is hardcoded to 0 (known TODO at
`grpc.rs:553`). External consumers like Nova need accurate health data to make smart session
placement decisions and alert on resource issues.

## What Changes
- Fix `uptime_seconds` to use the actual agent start time from `AppState`
- Create capability spec documenting the health API contract

## Impact
- Affected specs: `health-monitoring` (new capability spec)
- Affected code: `crates/nexus-agent/src/grpc.rs` (GetHealth handler)
- Trivial fix — one field
