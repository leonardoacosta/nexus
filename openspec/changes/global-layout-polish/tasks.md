## 1. Tabs Widget
- [ ] 1.1 Add `Tabs` widget to the base layout in main.rs — render above all screen content
- [ ] 1.2 Define tab labels: Dashboard, Health, Projects (the 3 cycled screens)
- [ ] 1.3 Highlight current screen tab using `Tabs::select()` based on `app.current_screen`
- [ ] 1.4 Style tabs: inactive=TEXT_DIM, active=PRIMARY with underline or block highlight
- [ ] 1.5 Adjust all screen layouts to account for the Tabs row height (add 1-row constraint at top)

## 2. Consistent Borders
- [ ] 2.1 Apply `BorderType::Rounded` to main content Block on dashboard.rs
- [ ] 2.2 Apply `BorderType::Rounded` to main content Block on health.rs
- [ ] 2.3 Apply `BorderType::Rounded` to main content Block on projects.rs
- [ ] 2.4 Apply `BorderType::Rounded` to content panels on stream.rs (message area + input bar)
- [ ] 2.5 Apply `BorderType::Rounded` to detail.rs panels (left + right sections)
- [ ] 2.6 Apply `BorderType::Rounded` to palette.rs overlay

## 3. Consistent Padding
- [ ] 3.1 Add `Block::padding(Padding::horizontal(1))` to all content Blocks across screens
- [ ] 3.2 Ensure status bar row has no extra padding (keep compact)

## 4. Paragraph Wrap
- [ ] 4.1 Audit all Paragraph usages — add `Paragraph::wrap(Wrap { trim: true })` where missing
- [ ] 4.2 Check markdown.rs table rendering — ensure manual width capping is consistent with wrap behavior

## 5. Validation
- [ ] 5.1 `cargo build` passes
- [ ] 5.2 `cargo test` — all tests pass
- [ ] 5.3 Manual smoke: verify Tabs visible on all screens, borders rounded, padding consistent, no layout overflow
