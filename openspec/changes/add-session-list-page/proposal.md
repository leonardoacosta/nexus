# Add Session List Page

## Why
The dashboard's primary value is showing all active Claude Code sessions across every machine at a glance. Without a session list page, users have no visibility into what's running where, which is the core user journey Nexus exists to serve.

## What Changes
Build the dashboard index page with session cards grouped by project, each showing project name, machine hostname, status dot, duration, and last activity. Data flows through a Server Action that calls the agent client to parallel-fetch all agents, with 5-second polling for near-real-time updates. Includes empty state, status badges, relative timestamps, and sorting (active first, then by last activity).
