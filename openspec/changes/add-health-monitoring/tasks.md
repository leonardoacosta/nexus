## 1. Dependencies and Types
- [x] [1.1] Add systeminformation to apps/agent dependencies [owner:engineer]
- [x] [1.2] Define HealthMetrics type in packages/core: cpu (overall%, per-core%, load avg), ram (total, used, %), disk (per-mount), docker (container count, running count), network (interface stats) [owner:engineer]
- [x] [1.3] Define ProcessInfo type in packages/core: pid, name, cpu_percent, ram_percent [owner:engineer]

## 2. Health Collector
- [x] [2.1] Implement health collector service with configurable poll interval (default 5s) [owner:engineer]
- [x] [2.2] Collect CPU metrics: overall percent, per-core percent, load average via systeminformation [owner:engineer]
- [x] [2.3] Collect RAM metrics: total, used, percent via systeminformation [owner:engineer]
- [x] [2.4] Collect disk metrics: per-mount total, used, percent via systeminformation [owner:engineer]
- [x] [2.5] Collect Docker metrics: container count and running count, return null if Docker unavailable [owner:engineer]
- [x] [2.6] Collect network interface stats: bytes in/out per interface [owner:engineer]
- [x] [2.7] Collect top 10 processes by CPU and top 10 by RAM for expanded detail view (REQ-HEALTH-4) [owner:engineer]

## 3. API Integration
- [x] [3.1] Update GET /health endpoint to return live HealthMetrics instead of stubbed values [owner:engineer]
- [x] [3.2] Add optional ?detail=true query param to include per-process breakdown and network stats [owner:engineer]

## 4. Validation
- [x] [4.1] Write unit tests with mocked systeminformation responses for each metric category [owner:engineer]
- [x] [4.2] Write test verifying graceful Docker fallback when docker socket is unavailable [owner:engineer]
- [x] [4.3] Verify GET /health response shape matches PRD REQ-HEALTH-2 contract [owner:engineer]
