Parent DOX: [web](../AGENTS.md).

# Purpose

Shared terminal display state adapted from the8020/dev-core at ff0b4bcf076581b59fb5e52b7168f33958a9723f.

# Ownership

Canonical headless engine, browser snapshot restore, touch interaction and path/URL link gestures.

# Local Contracts

Shared engine/state validation throws `MessageError` from `../message.ts`, preserving `{key, vars}` for both browser formatting and Goja transport. Do not import a browser catalog or DOM-dependent formatter into the headless engine.

Pin browser and headless xterm to 6.0.0 with the same Unicode 11 width provider installed before parsing/restoring. Emoji such as 👋 and 👍 occupy two columns. Snapshot version `the8020.xterm-6.0.0.2` identifies this shared width contract. Preserve parser continuation, both buffers, modes, colors, links, and cursor. Only the canonical engine answers application queries; browser viewers do not replay historical effects. Keep private xterm access in state.ts.

Capture cell arrays once and JSON-detach the remaining engine metadata; snapshots must stay independent of later output. Preserve the snapshot format and history limits. Validate every cell as an exact uint32, including sparse entries, and count validated arrays toward the same structural/depth bounds without walking their cells again. Retain generic metadata and text validation.

state.ts's installTerminalMetrics replaces the pinned DOM renderer's integer offsetWidth measurement with computed CSS width for its 32-character measurement run. Preserve fractional precision, zero-width handling and font-variant caches; use untransformed layout dimensions so workspace motion does not corrupt measurements. Install after terminal.open and refresh the renderer's spacing cache. If the regular `W` reference glyph cannot be measured while hidden/detached, refresh default row spacing before rendering once it is measurable again; live spans and plain-text snapshots must inherit the same valid spacing. The same adapter paints Unicode Block Elements (U+2580–U+259F) with cell-sized geometry rather than font glyph bounds, retaining text for selection/copy and xterm foreground/background colors. Reassess these private-renderer adaptations when upgrading xterm.

terminalDimensions uses untransformed xterm content-box dimensions and measured cells. Subtract element padding, never a scrollbar allowance; the scrollbar overlays the grid.

Install installTerminalView after terminal.open. Its theme-service subscription paints the entire xterm element with the canonical background, including padding and incomplete-row space. Follow live palette changes and snapshot restoration without resetting application colors; dispose the subscription with xterm.

`terminalTheme` initializes with dark background `#1b2230` and foreground `#e6edf3`; saved theme colors arrive through the canonical palette. `setTerminalBackground` changes current/default background and the supplied foreground in the headless or browser palette, preserving ANSI colors and partial escape sequences. Go serializes its runtime call with output/snapshot operations; viewers apply the sequenced `background` event after prior writes. OSC 10/11 queries and OSC 110/111 resets use the saved foreground/background, which travels in the existing snapshot palette.

installTerminalResize keeps existing DOM rows, cursor and scrollbar geometry visible while resize output is parsed, without cloning the terminal or pausing input/acknowledgements. Release at the parsed DEC 2026 end, including after xterm's own timeout and before an adjacent new frame. For unmarked output, settle after 120 ms of parsing silence; a silent resize releases after 300 ms. During the five-second resize window, a parsed scrollback clear or synchronized-output begin can hold a late redraw; neither extends that deadline. Explicit release cancels this window. Preserve hidden-view handling, refresh final dimensions on release, and dispose timers/hooks with xterm. Keep all private renderer/viewport access in this adapter.

Release the hold before viewport scrollLines/scrollToLine computes against its scroll range, including xterm's automatic scroll-on-input before onData. Restore these methods on disposal. Never force a reader to the bottom merely because output or a redraw completes.

interaction.ts uses public terminal APIs and screen touch events. One-finger movement scrolls normal-buffer history by measured row height unless an application owns wheel reports. Application mouse modes and alternate-screen cursor keys use xterm's existing wheel encoder. Preserve taps, mouse selection and multi-touch zoom; cancel gesture state on touch cancellation/end and remove listeners on view disposal. This bridges the pinned xterm 6.0 touch regression; reassess when upgrading the matched engines.

paths.ts recognizes paths beginning with `/`, `./`, `../` or `~/`, excluding a standalone `/`, plus explicit `http://`, `https://` and `file://` URLs. Quoted paths retain spaces; file URIs decode once after line/column parsing and accept only an empty host, localhost or the server hostname from the index. Reject malformed escapes, file URI queries/fragments and other hosts/schemes. HTTP(S) ports, queries, fragments, IPv6 hosts and balanced trailing parentheses remain intact; trim surrounding prose punctuation. No bare-domain guessing or URL reachability probes. File existence checks remain deferred until activation.

Underline links only on hover through native xterm rendering. Map Unicode and wrapped rows to cell coordinates and bound wrapped-line scans. state.ts replaces the pinned built-in OSC provider with the shared provider while retaining its synchronous original range reader; reassess on xterm upgrades. Validate OSC destinations with the same scheme/host policy and never reinterpret labels overlapping an unsupported OSC link as detected paths/URLs. Remove xterm’s automatic OSC dashed underline only in the renderer’s scratch cell; preserve explicit SGR underlines/styles and the buffer’s OSC metadata across snapshots. HTTP(S) opens on the user's device in a new tab with noopener/noreferrer; file URIs use Tuxee's existing workspace file-browser operation.

Use Ctrl-click on Linux/Windows and Cmd-click on macOS for both detected and OSC links, including application mouse tracking; consume pointer and compatibility mouse events for the entire gesture before xterm sees them. Ordinary mouse clicks reach the terminal/application. Touch taps open only without application mouse tracking. Cancel on movement (including moving away and back), long presses, extra pointers, Escape or blur; preserve selection, scrolling and multi-touch. Hover identifies the platform modifier and shows the destination for web URLs. The same parser serves the T text-view selection action, which accepts selected paths/file URIs or HTTP(S) URLs, including explicitly selected spaces in paths.

# Work Guidance

Preserve upstream validation and memory bounds. Bundle runtime.ts into the Go terminal package; share state.ts with browser rendering.

# Verification

`node tests/terminal-state.mjs` checks snapshot independence, parser continuation and validation bounds, including sparse cells and structural budgets for already-validated arrays. The server's `BenchmarkSnapshotCapture` measures full-history capture time and allocations in Goja.

`node tests/terminal-metrics.mjs` verifies real Chromium column alignment across spaces, bold/italic text, wide/combined characters and emoji, three font stacks, 80/179/240 columns and DPR 1/1.25/2. Hidden/detached font changes must recover default row spacing so a plain-text row fits the same grid. It also verifies adjacent/split DEC 2026 frames retain the completed frame and its cursor, and query replies are suppressed without suppressing keyboard input. It checks block pixels/shapes and copied text, canonical snapshot background coverage, and full-width fitting without a scrollbar gutter. An optional recording path replays the supplied Spynel frame at its recorded dimensions and saves `test-results/spynel-replay-fixed.png`.

Resize regressions cover late and adjacent synchronized-frame ends, unmarked output, silent applications, the missing-end deadline and explicit release. The real PTY transport suite checks a SIGWINCH scrollback rebuild lasting beyond one second, stable old text/scrollbar until completion, pipelined output and metadata barriers.

Scroll regressions cover typing and explicit scrolling during a held redraw with growing history, intentional scrollback retention and continued bottom-following. The transport suite verifies the typing case through real SIGWINCH output and the footer scroll controls' bounds, themes, placement, keyboard/pointer activation and focus; mobile checks tap Jump to bottom after real touch scrolling.

Run `npm run build` after changing these sources, then `go test ./internal/terminal`. This bundles the same xterm engine for execution inside Go through goja; Node/Deno are not runtime dependencies.

`npm run test:mobile` exercises browser touch scrollback, application input and native desktop selection/copy through the real server/PTY; emulation does not verify physical iOS behavior.

# Child DOX Index

No children.
