## 1. Dialog Widget
- [ ] 1.1 Create `NewSessionDialog` struct with fields: selected_agent, project_code, cwd, active_field
- [ ] 1.2 Agent selector: dropdown populated from connected agents list (arrow keys to select)
- [ ] 1.3 Project code input: text input with tab-completion from ListProjects results
- [ ] 1.4 CWD input: text input, auto-populated from project registry when project code matches

## 2. RPC Integration
- [ ] 2.1 Add `start_session(agent, project, cwd)` to TUI client
- [ ] 2.2 On dialog submit: validate inputs, call StartSession RPC on selected agent
- [ ] 2.3 On success: close dialog, refresh sessions, select new session in dashboard
- [ ] 2.4 On error: display error message in dialog footer (red text)

## 3. Navigation
- [ ] 3.1 `n` from dashboard opens new session dialog
- [ ] 3.2 Tab cycles between fields (agent → project → cwd)
- [ ] 3.3 Enter on last field submits
- [ ] 3.4 Esc closes dialog without action

## 4. Validation
- [ ] 4.1 Open dialog, select agent, enter project, verify StartSession RPC succeeds
- [ ] 4.2 Verify new session appears in dashboard within 2s
- [ ] 4.3 Test error case: select disconnected agent, verify error message
- [ ] 4.4 `cargo clippy && cargo test` passes
