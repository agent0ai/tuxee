Parent DOX: [web](../AGENTS.md).

# Purpose

Shared terminal display state adapted from the8020/dev-core at ff0b4bcf076581b59fb5e52b7168f33958a9723f.

# Ownership

Canonical headless engine, browser snapshot restore, touch interaction.

# Local Contracts

Pin browser and headless xterm to 6.0.0 with the same Unicode 11 width provider installed before parsing/restoring. Emoji such as 👋 and 👍 occupy two columns. Snapshot version `the8020.xterm-6.0.0.2` identifies this shared width contract. Preserve parser continuation, both buffers, modes, colors, links, and cursor. Only the canonical engine answers application queries; browser viewers do not replay historical effects. Keep private xterm access in state.ts.

state.ts's installTerminalMetrics replaces the pinned DOM renderer's integer offsetWidth measurement with computed CSS width for its 32-character measurement run. Preserve fractional precision, zero-width handling and font-variant caches; use untransformed layout dimensions so workspace motion does not corrupt measurements. Install after terminal.open and refresh the renderer's spacing cache. The same adapter paints Unicode Block Elements (U+2580–U+259F) with cell-sized geometry rather than font glyph bounds, retaining text for selection/copy and xterm foreground/background colors. Reassess these private-renderer adaptations when upgrading xterm.

terminalDimensions uses untransformed xterm content-box dimensions and measured cells. Subtract element padding, never a scrollbar allowance; the scrollbar overlays the grid.

Install installTerminalView after terminal.open. Its theme-service subscription paints the entire xterm element with the canonical background, including padding and incomplete-row space. Follow live palette changes and snapshot restoration without resetting application colors; dispose the subscription with xterm.

interaction.ts uses public terminal APIs and screen touch events. One-finger movement scrolls normal-buffer history by measured row height unless an application owns wheel reports. Application mouse modes and alternate-screen cursor keys use xterm's existing wheel encoder. Preserve taps, mouse selection and multi-touch zoom; cancel gesture state on touch cancellation/end and remove listeners on view disposal. This bridges the pinned xterm 6.0 touch regression; reassess when upgrading the matched engines.

# Work Guidance

Preserve upstream validation and memory bounds. Bundle runtime.ts into the Go terminal package; share state.ts with browser rendering.

# Verification

`node tests/terminal-metrics.mjs` verifies real Chromium column alignment across spaces, bold/italic text, wide/combined characters and emoji, three font stacks, 80/179/240 columns and DPR 1/1.25/2. It checks block pixels/shapes and copied text, canonical snapshot background coverage, and full-width fitting without a scrollbar gutter. An optional recording path replays the supplied Spynel frame at its recorded dimensions and saves `test-results/spynel-replay-fixed.png`.

Run `npm run build` after changing these sources, then `go test ./internal/terminal`. This bundles the same xterm engine for execution inside Go through goja; Node/Deno are not runtime dependencies.

`npm run test:mobile` exercises browser touch scrollback, application input and native desktop selection/copy through the real server/PTY; emulation does not verify physical iOS behavior.

# Child DOX Index

No children.
