Parent DOX: [vendor](../AGENTS.md).

# Purpose

Locally bundled noVNC desktop client.

# Ownership

Matched `core/` and `vendor/` from https://github.com/novnc/noVNC/releases/tag/v1.6.0. The codeload tag archive SHA-256 is `5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa`. Integration belongs to `web/display.ts`.

# Local Contracts

Keep the matched upstream ES modules intact except for these two fixes. `core/rfb.js` rejects zero/subpixel/oversized framebuffer dimensions before scheduling a remote resize, so hidden/detached views cannot send invalid layouts. In `core/util/browser.js`, the H.264 support probe closes its output VideoFrame and decoder, including configuration/flush failures and already-closed decoders. This fixes a startup resource leak; keep it at the library owner, without caller shims. Use the source modules because the 1.6.0 npm CommonJS conversion retains an incompatible top-level await. Bundle locally without remote runtime imports. Verbatim noVNC/MPL/BSD/pako notices live in `third_party/NOVNC-*`; attribution/source availability is in `THIRD_PARTY_NOTICES.md`.

# Work Guidance

Update the complete matched source set and notices together.

# Verification

`node tests/novnc.mjs` verifies probe cleanup on success/failures and rejection of invalid remote framebuffer sizes; it also runs within test:gui. `npm run build` checks local bundling; `npm run test:gui` verifies the client against the minimal TigerVNC build.

# Child DOX Index

No children.
