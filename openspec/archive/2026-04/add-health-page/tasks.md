## 1. Components
- [x] [1.1] Build Gauge component (circular or bar) with color thresholds: green <80%, yellow 80-95%, red >95% [owner:engineer]
- [x] [1.2] Build Sparkline component (SVG-based, 24-hour data window) [owner:engineer]
- [x] [1.3] Build machine card component with hostname, uptime, CPU/RAM/disk gauges, sparklines, and Docker count [owner:engineer]
- [x] [1.4] Build expanded detail panel showing per-process top 10, disk by mount, and network stats [owner:engineer]

## 2. Offline Detection
- [x] [2.1] Add offline machine detection: grayed card with "Last seen N ago" display [owner:engineer]

## 3. Data Layer
- [x] [3.1] Implement Server Action for parallel health fetch from all agents [owner:engineer]
- [x] [3.2] Add warning threshold logic: yellow >80%, red >95% for all gauges [owner:engineer]

## 4. Testing
- [x] [4.1] Write component tests for Gauge, Sparkline, machine card, and detail panel [owner:engineer]
- [x] [4.2] Write E2E test: health page with 3 agents (2 online, 1 offline) [owner:engineer]
