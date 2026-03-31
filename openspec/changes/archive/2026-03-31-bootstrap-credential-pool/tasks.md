# Implementation Tasks

<!-- beads:epic:nexus-90l6 -->

## Core Helpers Batch

- [ ] [1.1] [P-1] Add `fingerprint_token(access_token: &str) -> String` to `crates/nexus-core/src/credentials.rs` — SHA-256 hash, first 8 hex chars [owner:engineer] [beads:nexus-8eep]
- [ ] [1.2] [P-1] Add `is_managed_symlink(path: &Path, pool_dir: &Path) -> bool` to `crates/nexus-core/src/credentials.rs` — checks if path is a symlink targeting inside pool_dir [owner:engineer] [beads:nexus-71nb]
- [ ] [1.3] [P-1] Add `claude_credentials_path() -> PathBuf` to `crates/nexus-core/src/paths.rs` — returns `~/.claude/.credentials.json` [owner:engineer] [beads:nexus-l9tz]
- [ ] [1.4] [P-2] Add unit tests for `fingerprint_token` — deterministic output, 8 char hex, different tokens produce different fingerprints [owner:engineer] [beads:nexus-6n00]
- [ ] [1.5] [P-2] Add unit tests for `is_managed_symlink` — real file returns false, symlink into pool returns true, symlink elsewhere returns false [owner:engineer] [beads:nexus-j5gz]

## Credential Pool Bootstrap Batch

- [ ] [2.1] [P-1] Replace passthrough-on-missing-dir with `create_dir_all()` in `credential_pool.rs::start()` — create `~/.config/nexus/credentials/` if absent, then proceed to scan [owner:engineer] [beads:nexus-qpsd]
- [ ] [2.2] [P-1] Add initial bootstrap logic after scan: if pool is empty AND `claude_credentials_path()` is a real file (not symlink), import it via fingerprint naming, then convert to symlink [owner:engineer] [beads:nexus-wnm4]
- [ ] [2.3] [P-2] After bootstrap import, update in-memory accounts vec with the newly imported account before entering the watch loop [owner:engineer] [beads:nexus-38jc]
- [ ] [2.4] [P-2] Adjust passthrough condition: only enter passthrough when dir exists, is empty, AND no CC credential file detected as importable [owner:engineer] [beads:nexus-xl6q]

## Auto-Import Bridge Batch

- [ ] [3.1] [P-1] In `credential_watcher.rs`, add import bridge: when `.credentials.json` changes, check `is_managed_symlink()` first — if managed, skip; if not, compute fingerprint and copy to pool dir as `acct-{fingerprint}.json` [owner:engineer] [beads:nexus-o6fq]
- [ ] [3.2] [P-1] Add `sha2` crate dependency to `nexus-core/Cargo.toml` for SHA-256 hashing [owner:engineer] [beads:nexus-ardd]
- [ ] [3.3] [P-2] If fingerprint file already exists in pool dir, overwrite it (token refresh with same account identity) [owner:engineer] [beads:nexus-r1m5]
- [ ] [3.4] [P-2] After successful import, notify the credential pool service to re-scan (trigger file watcher event naturally via the pool dir watcher) [owner:engineer] [beads:nexus-gyfw]

## Name Discovery Batch

- [ ] [4.1] [P-2] After importing a new credential, attempt API call to resolve human-readable account name — try existing `query_usage` response for account identifiers, or a GET to a profile endpoint [owner:engineer] [beads:nexus-bfw2]
- [ ] [4.2] [P-2] If name resolved, rename pool file from `acct-{fingerprint}.json` to `acct-{sanitized_name}.json`, update in-memory account entry [owner:engineer] [beads:nexus-2cic]
- [ ] [4.3] [P-2] Sanitize discovered name for filesystem use — lowercase, replace non-alphanumeric with hyphens, truncate to 32 chars [owner:engineer] [beads:nexus-n84v]
- [ ] [4.4] [P-2] Fall back to fingerprint name silently if API call fails or returns no usable name [owner:engineer] [beads:nexus-14b4]

## Verification Batch

- [ ] [5.1] Verify `cargo build` succeeds for all workspace crates after changes [owner:engineer] [beads:nexus-knzq]
- [ ] [5.2] Verify `cargo test` passes — new fingerprint, symlink detection, and bootstrap tests [owner:engineer] [beads:nexus-l8ef]
- [ ] [5.3] Verify `cargo clippy` reports no new warnings [owner:engineer] [beads:nexus-bxsu]
