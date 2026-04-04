# Add Health Monitoring

## Why
The agent skeleton serves stubbed health data. Real system metrics (CPU, RAM, disk, Docker, processes) are required for the dashboard Health page to display meaningful gauges and sparklines. Without real metrics, the health endpoint is decorative.

## What Changes
Replace stubbed health values with live system metrics collected via the `systeminformation` npm package. Implement a configurable collection interval (default 5s), structured response matching PRD REQ-HEALTH-2, per-process CPU/RAM breakdown for expanded detail views (REQ-HEALTH-4), and graceful handling when Docker is not installed.

## Specs
See specs/ directory (if applicable).
