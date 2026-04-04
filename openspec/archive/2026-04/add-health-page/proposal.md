# Add Health Page

## Why
Developers running agents across multiple machines need a single view of system health to spot resource pressure before it causes session failures. Without a health page, diagnosing slow builds or OOM kills requires SSH-ing into each box individually.

## What Changes
Build the /health page with one machine card per agent showing hostname, uptime, CPU/RAM/disk gauges with color thresholds (yellow >80%, red >95%), 24-hour sparklines, and Docker container count. Cards expand to show per-process top 10, disk by mount, and network stats. Offline agents render as grayed cards with "Last seen N ago" timestamps. Data fetched via parallel Server Actions.
