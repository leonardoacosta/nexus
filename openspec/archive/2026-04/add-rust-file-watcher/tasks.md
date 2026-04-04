## 1. Extraction
- [x] [1.1] Extract notify watcher logic from crates/nexus-agent/src/watcher/ into packages/watcher/src/main.rs [owner:engineer]
- [x] [1.2] Define IPC message types as Rust structs with serde Serialize/Deserialize (session_start, session_update, session_end, watch, shutdown) [owner:engineer]

## 2. IPC Implementation
- [x] [2.1] Implement stdin reader for control messages (watch, shutdown) with newline-delimited JSON parsing [owner:engineer]
- [x] [2.2] Implement stdout writer for session events (session_start, session_update, session_end) as newline-delimited JSON [owner:engineer]

## 3. Build
- [x] [3.1] Add Cargo.toml to packages/watcher with notify, serde, serde_json dependencies [owner:engineer]
- [x] [3.2] Add Cargo build script (packages/watcher/build.rs or package.json build script) for cargo build --release [owner:engineer]

## 4. Testing
- [x] [4.1] Write integration test: spawn watcher binary, send watch command via stdin, verify session events on stdout [owner:engineer]

## 5. Documentation
- [x] [5.1] Document IPC protocol (message types, flow, examples) in packages/watcher/README.md [owner:engineer]
