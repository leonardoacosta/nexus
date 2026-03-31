# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Move `detect_docker_containers()` at line 60 inside the `spawn_blocking` closure at line 67, passing the refresh counter in and returning the updated docker cache alongside sys and snapshot [owner:api-engineer]
- [ ] [1.2] [P-1] Wrap the initial `detect_docker_containers()` call at line 44 in `tokio::task::spawn_blocking` [owner:api-engineer]
- [ ] [1.3] [P-2] Verify `cargo build -p nexus-agent` compiles cleanly [owner:api-engineer]
- [ ] [1.4] [P-2] Verify `cargo test -p nexus-agent` passes [owner:api-engineer]
