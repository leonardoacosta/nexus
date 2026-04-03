# Add Health History

## Why
Live health metrics show only the current instant. The dashboard needs historical health data to render sparkline trend charts (REQ-HEALTH-3) showing CPU, RAM, and disk over the last 24 hours. Without periodic snapshots, there is no time-series data to query.

## What Changes
Implement a snapshot scheduler that writes health metrics to the SQLite health_snapshots table at a configurable interval (default 30s). Add a GET /health/history endpoint that returns sparkline-ready time-series arrays for a given time window. Reuse the retention cleanup from add-sqlite-store (30-day TTL).

## Specs
See specs/ directory (if applicable).
