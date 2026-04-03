## 1. Snapshot Scheduler
- [ ] [1.1] Implement periodic snapshot scheduler with configurable interval (default 30 seconds) [owner:engineer]
- [ ] [1.2] Collect current health metrics from health collector and write to health_snapshots table [owner:engineer]
- [ ] [1.3] Wire scheduler startup into agent main entry point (start after health collector is ready) [owner:engineer]
- [ ] [1.4] Ensure graceful scheduler shutdown on agent SIGTERM/SIGINT [owner:engineer]

## 2. Time-Series API
- [ ] [2.1] Implement GET /health/history endpoint with ?hours=N query parameter (default 24) [owner:engineer]
- [ ] [2.2] Return sparkline-ready array: [{timestamp, cpu_percent, ram_percent, disk_percent}] ordered by timestamp [owner:engineer]
- [ ] [2.3] Downsample results for large time windows (e.g., 1 point per 5 min for 24h, 1 per 30 min for 7d) [owner:engineer]
- [ ] [2.4] Register route in agent HTTP server router [owner:engineer]

## 3. Retention
- [ ] [3.1] Verify integration with add-sqlite-store retention cleanup (health_snapshots older than 30 days) [owner:engineer]

## 4. Validation
- [ ] [4.1] Write test: scheduler writes snapshots at configured interval to health_snapshots table [owner:engineer]
- [ ] [4.2] Write test: GET /health/history?hours=1 returns correct time-series data [owner:engineer]
- [ ] [4.3] Write test: downsampling produces expected number of data points for large time windows [owner:engineer]
- [ ] [4.4] Write test: empty history returns empty array (not error) [owner:engineer]
