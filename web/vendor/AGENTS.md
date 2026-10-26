Parent DOX: [web](../AGENTS.md).

# Purpose

Locally vendored frontend libraries.

# Ownership

Own the CodeMirror 6 JavaScript chunks copied from the8020/uui commit b14a6096fee6bd4f64c6b25c16064822cefb225a, services/shell/frontend/components/code-editor/vendor. Integration stays in web/editor.ts and web/editor-page.ts. The latter imports WidgetType from the matched chunk-36OFQ4TD.js export `u`, which library.js does not re-export.

The novnc child owns the pinned noVNC desktop client; integration stays in web/display.ts.

`code-editor/xml.js` is the unchanged standalone `mode/xml.js` from `@codemirror/legacy-modes` 6.5.4, matching the version already covered by the CodeMirror notices. editor.ts wraps it with the bundled StreamLanguage; it does not introduce another CodeMirror instance or modify the matched chunks.

# Local Contracts

Keep vendor chunks intact and matched except the shell command-list fix below and the documented noVNC resource-lifetime and framebuffer-size fixes described in its child contract. Build resolves all local language imports into the self-contained index. No CDN or remote imports. Verbatim licenses live in third_party/CODEMIRROR-LICENSES.txt; source attribution lives in THIRD_PARTY_NOTICES.md.

`code-editor/shell-YUCGLZSD.js` adds `exec` to the bundled shell mode's built-in command list. Preserve this fix when updating unless upstream includes it; command recognition otherwise retains the upstream static list.

# Work Guidance

Update the complete matched set and licenses when updating the editor library.

# Verification

npm run build verifies no external runtime imports. npm run test:features checks editor language selection, highlighting, saving and previews against the native server. `node tests/inspector.mjs` covers shell tokens in both themes and syntax switching.

# Child DOX Index

- [novnc/AGENTS.md](novnc/AGENTS.md): noVNC 1.6.0 ES modules, documented probe cleanup and bundled pako.
