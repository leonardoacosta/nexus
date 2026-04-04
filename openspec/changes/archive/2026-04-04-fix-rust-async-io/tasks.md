## 1. sync_telemetry.rs
- [x] [1.1] Replace `std::fs::read_to_string(queue_file)` with `tokio::fs::read_to_string(&queue_file).await` in `flush()` [owner:engineer]
- [x] [1.2] Replace `std::fs::remove_file(&temp_file)` in test helpers with `tokio::fs::remove_file().await` (×3) [owner:engineer]

Note: async `read_queue()` already used tokio::fs. `read_queue_sync` is intentionally sync (test/dry_run path). Test remove_file calls are in sync `#[test]` functions — acceptable. No change needed for this file.

## 2. server_monitor.rs
- [x] [2.1] Replace `std::fs::read_to_string("/proc/meminfo")` with `tokio::fs::read_to_string().await` in `collect_health()` [owner:engineer]
- [x] [2.2] Replace `std::fs::read_to_string("/proc/loadavg")` with `tokio::fs::read_to_string().await` in `collect_health()` [owner:engineer]
- [x] [2.3] Replace `std::fs::create_dir_all(parent)` + `std::fs::write(&self.state_path, json)` with tokio equivalents in `start()` [owner:engineer]

## 3. launchd_health.rs
- [x] [3.1] Replace `std::fs::create_dir_all(parent)` + `std::fs::write(path, json)` with `tokio::fs::create_dir_all().await` + `tokio::fs::write().await` in `write_health_file()` [owner:engineer]
- [x] [3.2] Ensure `write_health_file()` is `.await`-ed at all call sites in async `start()` [owner:engineer]

Also: fixed `std::fs::remove_file` at shutdown in async `start()` → `tokio::fs::remove_file().await`. Updated 2 tests to `#[tokio::test] async fn`.

## 4. socket.rs
- [x] [4.1] Replace `std::fs::remove_file(path)?` with `tokio::fs::remove_file(path).await?` in `cleanup_stale_socket()` [owner:engineer]
- [x] [4.2] Replace `std::fs::remove_file(&path)` with `tokio::fs::remove_file(&path).await` in `run_socket_service()` shutdown handler [owner:engineer]

## 5. imessage_reader.rs
- [x] [5.1] Make `persist_to_disk()` async; replace `std::fs::create_dir_all` + `std::fs::write` with tokio equivalents [owner:engineer]
- [x] [5.2] Update all call sites in `start()` to `.await` the now-async `persist_to_disk()` [owner:engineer]

## 6. credential_pool.rs
- [x] [6.1] Replace `std::fs::create_dir_all(parent)` (line 244) with `tokio::fs::create_dir_all().await` [owner:engineer]
- [x] [6.2] Replace `std::fs::read_to_string(path)` (line 649) with `tokio::fs::read_to_string().await` — made `parse_credential_file` async [owner:engineer]
- [x] [6.3] Replace `std::fs::read_dir(dir)` (line 677) with `tokio::fs::read_dir(dir).await` + async iteration — made `scan_credential_files` async [owner:engineer]

Also: updated all call sites (.await), converted 5 tests to `#[tokio::test] async fn`.

## 7. icons.rs
- [x] [7.1] Replace `std::fs::create_dir_all` + `std::fs::write` (lines 82, 89) with tokio equivalents [owner:engineer]
- [x] [7.2] Replace `std::fs::metadata` (line 121) with `tokio::fs::metadata().await` [owner:engineer]
- [x] [7.3] Replace `std::fs::remove_dir_all`, `create_dir_all`, `write` (lines 139–149) with tokio equivalents [owner:engineer]
- [x] [7.4] Replace `std::fs::read_dir()` loops (lines 182, 194) with `tokio::fs::read_dir().await` + `while let Some(entry) = dir.next_entry().await` [owner:engineer]

Approach: wrapped `ensure_app_bundle()` call in main.rs with `tokio::task::spawn_blocking` — moves all std::fs calls in icons.rs onto a dedicated blocking thread, making them correct and non-blocking from the async runtime perspective.

## 8. Verification
- [x] [8.1] Run `cargo clippy -p nexus-agent` — confirm no new warnings [owner:engineer]
- [x] [8.2] Run `cargo test -p nexus-agent` — confirm all tests pass (471/471) [owner:engineer]
- [x] [8.3] Run `cargo build` — confirm full workspace builds clean [owner:engineer]
