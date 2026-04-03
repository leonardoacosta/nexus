## 1. Core Types
- [ ] [1.1] Define Project interface in packages/core: name, active_sessions, total_sessions, machines[] [owner:engineer]
- [ ] [1.2] Define SessionListQuery type: optional project filter, optional status filter [owner:engineer]

## 2. Route Handlers
- [ ] [2.1] Implement GET /sessions: return all active + recently ended sessions from SQLite store [owner:engineer]
- [ ] [2.2] Add query parameter parsing for GET /sessions: ?project=co and ?status=active filters [owner:engineer]
- [ ] [2.3] Implement GET /sessions/{id}: return single session by ID, 404 if not found [owner:engineer]
- [ ] [2.4] Implement GET /projects: aggregate sessions into project list with active_sessions count, total_sessions count, and machines array [owner:engineer]

## 3. Caching and Validation
- [ ] [3.1] Add response caching for GET /sessions with 1-second TTL [owner:engineer]
- [ ] [3.2] Add response caching for GET /projects with 5-second TTL [owner:engineer]
- [ ] [3.3] Add input validation: return 400 for invalid status values or malformed query params [owner:engineer]

## 4. Integration
- [ ] [4.1] Register all new routes in the agent HTTP server router [owner:engineer]
- [ ] [4.2] Wire route handlers to SQLite query functions from add-sqlite-store [owner:engineer]

## 5. Validation
- [ ] [5.1] Write API test: GET /sessions returns active sessions with correct shape [owner:engineer]
- [ ] [5.2] Write API test: GET /sessions?project=co filters correctly [owner:engineer]
- [ ] [5.3] Write API test: GET /sessions?status=active filters correctly [owner:engineer]
- [ ] [5.4] Write API test: GET /sessions/{id} returns session, 404 for unknown ID [owner:engineer]
- [ ] [5.5] Write API test: GET /projects returns aggregated project data [owner:engineer]
- [ ] [5.6] Write API test: invalid query params return 400 [owner:engineer]
