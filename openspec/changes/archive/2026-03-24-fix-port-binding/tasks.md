## 1. Investigation
- [ ] 1.1 Audit main.rs for port configuration sources (env vars, config, hardcoded)
- [ ] 1.2 Audit systemd service file for port-related env vars or socket activation
- [ ] 1.3 Check if any other process or config could cause port 8400 binding

## 2. Fix
- [ ] 2.1 Ensure gRPC server binds exclusively to port 7400 (no fallback ports)
- [ ] 2.2 Ensure HTTP health server binds exclusively to port 7401 (no fallback ports)
- [ ] 2.3 Add startup INFO log: "listening on gRPC=0.0.0.0:7400 HTTP=0.0.0.0:7401"
- [ ] 2.4 Add startup assertion that verifies ports are bound before accepting connections

## 3. Validation
- [ ] 3.1 Deploy to homelab, restart agent, verify `ss -tlnp | grep 7400` and `ss -tlnp | grep 7401`
- [ ] 3.2 Verify curl http://localhost:7401/health returns expected JSON
- [ ] 3.3 `cargo clippy && cargo test` passes
