# Add Projects Page

## Why
Users managing many Claude Code sessions need a project-centric view to understand which projects have active work and where that work is distributed across machines. The session list groups by project but doesn't provide aggregate project-level metrics or drill-down navigation.

## What Changes
Build the /projects page with project cards showing project name, active session count, total session count, and machine distribution. Clicking a project card navigates to /projects/{name} which renders a filtered session list for that project. Data aggregated from all agents via Server Action.
