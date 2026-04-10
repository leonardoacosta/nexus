# Capability: agent-structure

## MODIFIED Requirements

### Requirement: Declarative route dispatch
The system SHALL replace the hand-rolled if/else chain in `server.ts:createRequestHandler` with a declarative route table. Routes MUST be defined as data objects. A shared `withErrorHandler` wrapper MUST handle the `.catch()` boilerplate. WebSocket lifecycle management MUST be extracted to `server-websocket.ts`.

#### Scenario: Route table replaces if/else chain
- Given server.ts contains 54 inline route registrations in a 590-line function
- When the route table refactor is applied
- Then routes are defined as `{ method, path, handler }` data objects in `router.ts`
- And `server.ts` drops to approximately 300 lines
- And all existing route tests continue to pass

#### Scenario: WebSocket lifecycle is extracted
- Given `ServerState`, ping/pong, and federation logic are mixed into the request handler
- When the extraction is applied
- Then WebSocket concerns live in `server-websocket.ts`
- And the request handler delegates WebSocket upgrades to the extracted module

## REMOVED Requirements

### Requirement: Remove AppContext abstraction
The `AppContext` type, `DedupMap`, `BoundedMap`, and `CommandState` classes are removed. Module-level singletons remain as the canonical state management pattern.

#### Scenario: Deleting AppContext and duplicates
- Given `context.ts` defines AppContext, DedupMap, BoundedMap, CommandState
- And `ctx?: AppContext` is accepted but never used in server.ts
- And DedupMap is duplicated in notifications.ts
- And ProjectRules is duplicated in command-handler.ts
- When the deletion is applied
- Then `context.ts` and `context.test.ts` are deleted
- And all `ctx` parameters are removed from function signatures
- And duplicate interfaces are removed (only the actively-used copy remains)

### Requirement: Remove singleton side-effect
The module-level `_singletonState` eager creation is removed. `ServerState.create()`, `HealthCollector.start()`, and `StreamManager` instantiation are deferred to `startServer()`.

#### Scenario: No side-effects on import
- Given importing `server.ts` currently triggers `HealthCollector.start()` with `setInterval`
- When the deferral is applied
- Then importing `server.ts` has no side effects
- And `startServer()` initializes all singletons at call time
