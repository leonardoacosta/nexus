# Add Session Detail Page

## Why
After identifying a session on the dashboard, users need a dedicated view to inspect its full metadata and eventually interact with its terminal. Without a detail page, users would have to SSH into the machine manually to get any information beyond the summary card.

## What Changes
Build the /sessions/{id} detail page with a two-column layout: a terminal placeholder on the left (for future terminal widget integration) and a metadata sidebar on the right showing project name, machine hostname, status, duration, PID, and CWD. A top bar displays the session ID and back navigation. Routing is wired from session card clicks on the dashboard.
