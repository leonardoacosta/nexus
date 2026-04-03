## 1. Parser
- [ ] [1.1] Implement TOML parser for agents.toml with Zod schema validation (AgentConfig: name, host, port) in packages/core [owner:engineer]
- [ ] [1.2] Handle parse errors gracefully with structured error messages (invalid TOML, schema violations) [owner:engineer]

## 2. Hot Reload
- [ ] [2.1] Add fs.watch on ~/.config/nexus/agents.toml for file change detection [owner:engineer]
- [ ] [2.2] Emit typed config-change events (EventEmitter or callback pattern) for downstream consumers [owner:engineer]
- [ ] [2.3] Debounce rapid file changes to avoid duplicate reloads [owner:engineer]

## 3. Testing
- [ ] [3.1] Write tests for TOML parsing: valid config, missing fields, malformed TOML [owner:engineer]
- [ ] [3.2] Write tests for hot-reload: modify config file, verify event emitted with updated config [owner:engineer]
