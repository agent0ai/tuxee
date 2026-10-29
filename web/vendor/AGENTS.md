Parent DOX: [web](../AGENTS.md).

# Purpose

Locally vendored frontend libraries.

# Ownership

Own the CodeMirror 6 JavaScript chunks rebuilt with esbuild from the8020/uui commit b14a6096fee6bd4f64c6b25c16064822cefb225a's code-editor library entrypoint, using the package versions in the bundled notices. Add WidgetType and @codemirror/search 6.7.2 to that entrypoint so the editor and search share one CodeMirror runtime. Integration stays in web/editor.ts, web/editor-page.ts and web/editor-search.ts.

The novnc child owns the pinned noVNC desktop client; integration stays in web/display.ts.

`code-editor/xml.js` is the unchanged standalone `mode/xml.js` from `@codemirror/legacy-modes` 6.5.4, matching the version already covered by the CodeMirror notices. editor.ts wraps it with the bundled StreamLanguage; it does not introduce another CodeMirror instance or modify the matched chunks.

# Local Contracts

Keep vendor chunks intact and matched except the shell command-list, Go numeric-token and search-announcement fixes below and the documented noVNC resource-lifetime and framebuffer-size fixes described in its child contract. Build resolves all local language imports into the self-contained index. No CDN or remote imports. Verbatim licenses live in third_party/CODEMIRROR-LICENSES.txt; source attribution lives in THIRD_PARTY_NOTICES.md.

`code-editor/shell-XT4L6IAW.js` adds `exec` to the bundled shell mode's built-in command list. Preserve this fix when updating unless upstream includes it; command recognition otherwise retains the upstream static list.

`code-editor/go-MWSJ5GRW.js` starts a number with a dot only when the next character is a digit. Preserve this fix when updating unless upstream includes it; member-access dots remain punctuation while `.5`, decimal and exponent numbers retain highlighting.

The bundled search module changes its match announcement to one `Match on line $1: $2` phrase, allowing the line number and text to be translated together instead of concatenating English fragments. Its `lineOffset` search option adjusts match and replacement announcements to the file's line numbers on later pages. Preserve these adaptations when rebuilding.

# Work Guidance

Update the complete matched set and licenses when updating the editor library.

# Verification

npm run build verifies no external runtime imports. npm run test:features checks editor language selection, highlighting, saving and previews against the native server. `node tests/inspector.mjs` covers shell tokens in both themes and syntax switching. `node tests/editor-search.mjs` exercises the shared search module in the editor.
`node tests/editor-syntax.mjs` checks every bundled mode, file-extension detection, contrast in both themes and Go dot/number tokenization against the real editor.

# Child DOX Index

- [novnc/AGENTS.md](novnc/AGENTS.md): noVNC 1.6.0 ES modules, documented probe cleanup and bundled pako.
