# Change: Remove 6 orphaned tmp files from nexus-agent (~1,670 dead lines)

## Why
The nexus-agent crate contains 6 temporary files totaling 1,670 lines that are not declared as modules anywhere. They are leftovers from refactoring or editor swap operations and contribute zero functionality. Removing them reduces codebase noise and simplifies navigation.

## What Changes
- Delete `crates/nexus-agent/src/tmp.Ivy7xTb8d2.rs` (265 lines)
- Delete `crates/nexus-agent/src/tmp.NNWJ78si7M.rs` (262 lines)
- Delete `crates/nexus-agent/src/tmp.XDxFD6ec8G.rs` (264 lines)
- Delete `crates/nexus-agent/src/grpc/tmp.6y1l629Rep.rs` (302 lines)
- Delete `crates/nexus-agent/src/grpc/tmp.Oqhw4vwLMk.rs` (294 lines)
- Delete `crates/nexus-agent/src/grpc/tmp.wRXEchDOq1.rs` (283 lines)

## Impact
- Affected specs: none (files are unreferenced dead code)
- Affected code: `crates/nexus-agent/src/` and `crates/nexus-agent/src/grpc/`
- Risk: none — git history preserves content if ever needed
