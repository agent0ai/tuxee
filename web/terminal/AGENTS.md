Parent DOX: [web](../AGENTS.md).

# Purpose

Shared terminal display state adapted from the8020/dev-core at ff0b4bcf076581b59fb5e52b7168f33958a9723f.

# Ownership

Canonical headless engine, browser snapshot restore, touch interaction.

# Local Contracts

Pin browser and headless xterm to 6.0.0. Preserve parser continuation, both buffers, modes, colors, links, and cursor. Only the canonical engine answers application queries; browser viewers do not replay historical effects. Keep private xterm access in state.ts.

state.ts's installTerminalMetrics replaces the pinned DOM renderer's integer offsetWidth measurement with computed CSS width for its 32-character measurement run. Preserve fractional precision, zero-width handling and font-variant caches; use untransformed layout dimensions so workspace motion does not corrupt measurements. Install after terminal.open and refresh the renderer's spacing cache. Reassess this adaptation when upgrading xterm.

interaction.ts uses public terminal APIs and screen touch events. One-finger movement scrolls normal-buffer history by measured row height unless an application owns wheel reports. Application mouse modes and alternate-screen cursor keys use xterm's existing wheel encoder. Preserve taps, mouse selection and multi-touch zoom; cancel gesture state on touch cancellation/end and remove listeners on view disposal. This bridges the pinned xterm 6.0 touch regression; reassess when upgrading the matched engines.

# Work Guidance

Preserve upstream validation and memory bounds. Bundle runtime.ts into the Go terminal package; share state.ts with browser rendering.

# Verification

`node tests/terminal-metrics.mjs` verifies real Chromium column alignment across spaces, bold/italic text, wide/combined characters, three font stacks, 80/179/240 columns and device pixel ratios 1/1.25/2.

Run `npm run build` after changing these sources, then `go test ./internal/terminal`. This bundles the same xterm engine for execution inside Go through goja; Node/Deno are not runtime dependencies.

`npm run test:mobile` exercises browser touch scrollback, application input and native desktop selection/copy through the real server/PTY; emulation does not verify physical iOS behavior.

# Child DOX Index

No children.
