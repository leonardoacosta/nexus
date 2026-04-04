## 1. sync_telemetry.rs
- [ ] [1.1] Replace `std::fs::read_to_string(queue_file)` with `tokio::fs::read_to_string(&queue_file).await` in `flush()` [owner:engineer]
- [ ] [1.2] Replace `std::fs::remove_file(&temp_file)` in test helpers with `tokio::fs::remove_file().await` (×3) [owner:engineer]

## 2. server_monitor.rs
- [ ] [2.1] Replace `std::fs::read_to_string("/proc/meminfo")` with `tokio::fs::read_to_string().await` in `collect_health()` [owner:engineer]
- [ ] [2.2] Replace `std::fs::read_to_string("/proc/loadavg")` with `tokio::fs::read_to_string().await` in `collect_health()` [owner:engineer]
- [ ] [2.3] Replace `std::fs::create_dir_all(parent)` + `std::fs::write(&self.state_path, json)` with tokio equivalents in `start()` [owner:engineer]

## 3. launchd_health.rs
- [ ] [3.1] Replace `std::fs::create_dir_all(parent)` + `std::fs::write(path, json)` with `tokio::fs::create_dir_all().await` + `tokio::fs::write().await` in `write_health_file()` [owner:engineer]
- [ ] [3.2] Ensure `write_health_file()` is `.await`-ed at all call sites in async `start()` [owner:engineer]

## 4. socket.rs
- [ ] [4.1] Replace `std::fs::remove_file(path)?` with `tokio::fs::remove_file(path).await?` in `cleanup_stale_socket()` [owner:engineer]
- [ ] [4.2] Replace `std::fs::remove_file(&path)` with `tokio::fs::remove_file(&path).await` in `run_socket_service()` shutdown handler [owner:engineer]

## 5. imessage_reader.rs
- [ ] [5.1] Make `persist_to_disk()` async; replace `std::fs::create_dir_all` + `std::fs::write` with tokio equivalents [owner:engineer]
- [ ] [5.2] Update all call sites in `start()` to `.await` the now-async `persist_to_disk()` [owner:engineer]

## 6. credential_pool.rs
- [ ] [6.1] Replace `std::fs::create_dir_all(parent)` (line 244) with `tokio::fs::create_dir_all().await` [owner:engineer]
- [ ] [6.2] Replace `std::fs::read_to_string(path)` (line 649) with `tokio::fs::read_to_string().await` [owner:engineer]
- [ ] [6.3] Replace `std::fs::read_dir(dir)` (line 677) with `tokio::fs::read_dir(dir).await` + async iteration [owner:engineer]

## 7. icons.rs
- [ ] [7.1] Replace `std::fs::create_dir_all` + `std::fs::write` (lines 82, 89) with tokio equivalents [owner:engineer]
- [ ] [7.2] Replace `std::fs::metadata` (line 121) with `tokio::fs::metadata().await` [owner:engineer]
- [ ] [7.3] Replace `std::fs::remove_dir_all`, `create_dir_all`, `write` (lines 139–149) with tokio equivalents [owner:engineer]
- [ ] [7.4] Replace `std::fs::read_dir()` loops (lines 182, 194) with `tokio::fs::read_dir().await` + `while let Some(entry) = dir.next_entry().await` [owner:engineer]

## 8. Verification
- [ ] [8.1] Run `cargo clippy -p nexus-agent` — confirm no new warnings [owner:engineer]
- [ ] [8.2] Run `cargo test -p nexus-agent` — confirm all tests pass [owner:engineer]
- [ ] [8.3] Run `cargo build` — confirm full workspace builds clean [owner:engineer]
