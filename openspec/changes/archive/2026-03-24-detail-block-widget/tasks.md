## 1. Block Widget Migration
- [ ] 1.1 Replace `render_card()` function (detail.rs lines 199-247) — remove all Unicode box-drawing format! calls
- [ ] 1.2 Create `Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).title(title)` for each card
- [ ] 1.3 Use `block.inner(area)` to get the content area inside the Block
- [ ] 1.4 Render card content (key-value pairs) inside the inner area using Paragraph or Line spans
- [ ] 1.5 Add `Padding::horizontal(1)` to the Block for content spacing

## 2. Layout Preservation
- [ ] 2.1 Preserve the 2-panel horizontal layout (left: session metadata, right: status/timing)
- [ ] 2.2 Ensure both panels get Block widgets with matching style

## 3. Validation
- [ ] 3.1 `cargo build` passes
- [ ] 3.2 `cargo test` — all tests pass
- [ ] 3.3 Manual smoke: navigate to detail screen, verify cards render with rounded borders, no Unicode drawing artifacts
