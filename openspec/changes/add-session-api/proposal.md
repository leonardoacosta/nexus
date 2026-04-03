# Add Session API

## Why
The dashboard and external consumers need HTTP endpoints to query session data. Without an API layer, session and project data is locked inside the agent with no way to read it. This spec exposes the SQLite-backed session store as a RESTful API.

## What Changes
Add four HTTP endpoints to the agent: GET /sessions (filterable by project and status), GET /sessions/{id} (single session), and GET /projects (project list with session counts and machine distribution). Include query parameter validation, response caching (1s TTL for sessions, 5s for projects), and proper error responses (404, 400).

## Specs
See specs/ directory (if applicable).
