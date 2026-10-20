Parent DOX: [web](../AGENTS.md).

# Purpose

Shared terminal display state adapted from the8020/dev-core at ff0b4bcf076581b59fb5e52b7168f33958a9723f.

# Ownership

Canonical headless engine and browser snapshot restore.

# Local Contracts

Pin browser and headless xterm to 6.0.0. Preserve parser continuation, both buffers, modes, colors, links, and cursor. Only the canonical engine answers application queries; browser viewers do not replay historical effects. Keep private xterm access in state.ts.

# Work Guidance

Preserve upstream validation and memory bounds. Bundle runtime.ts into the Go terminal package; share state.ts with browser rendering.

# Verification

Run `npm run build` after changing these sources, then `go test ./internal/terminal`. This bundles the same xterm engine for execution inside Go through goja; Node/Deno are not runtime dependencies.

# Child DOX Index

No children.
