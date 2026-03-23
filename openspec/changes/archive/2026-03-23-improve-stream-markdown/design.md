## Context
The stream attach view currently renders all assistant text as plain `Color::White` lines with
simple character-boundary wrapping at 120 chars. No markdown parsing, no syntax highlighting,
no table rendering. This is the #1 UX gap compared to competing tools (OpenCode, Toad, OpenClaude).

## Goals / Non-Goals
- **Goal**: Render assistant markdown with headers, code blocks, tables, inline formatting
- **Goal**: Syntax-highlight code blocks by detected language
- **Goal**: Maintain streaming responsiveness (no full re-render on every character)
- **Non-Goal**: Rendering images or complex HTML embedded in markdown
- **Non-Goal**: User-customizable themes (use brand palette)

## Decisions
- **termimad over tui-markdown**: termimad is mature (2M+ downloads), handles tables, wrapping,
  scrolling natively. tui-markdown is experimental and limited. termimad's `MadSkin` system maps
  cleanly to our brand palette. Trade-off: termimad returns its own types that need conversion
  to ratatui `Line`/`Span`, but this is straightforward.
- **Paragraph-level streaming**: Don't re-render markdown on every partial character. Accumulate
  text until a paragraph break (double newline) or flush event, then render the complete paragraph.
  This prevents flicker and layout jumps from incomplete markdown constructs.
- **Code block state machine**: Track whether we're inside a code fence during streaming. If a
  ``` is opened but not closed, render accumulated lines as plain preformatted text (no highlighting)
  until the fence closes.

## Risks / Trade-offs
- termimad adds ~200KB to binary size → Acceptable for the UX improvement
- Partial markdown during streaming may briefly render incorrectly → Mitigated by paragraph batching
- Very long code blocks may impact scroll performance → Use lazy rendering (only render visible lines)
