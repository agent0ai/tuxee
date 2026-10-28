Parent DOX: [internal](../AGENTS.md).

# Purpose

One translation source for the browser and backend notices.

# Ownership

`locales/<code>.json` owns built-in texts; `i18n.go` owns loading, fallback, formatting, typed errors and cached immutable bundles. `check.mjs` owns catalog/source checks. Server owns session selection/injection; web owns rendering.

# Local Contracts

- JSON shape is `{"name":"Čeština","texts":{"files.renameFailed":"… {name} …"}}`. Use language-code filenames and native language names. Login sorts by code and prefixes the uppercase code. Required built-ins: `ar`, `bg`, `ca`, `cs`, `da`, `de`, `el`, `en`, `es`, `et`, `fa`, `fi`, `fil`, `fr`, `he`, `hi`, `hr`, `hu`, `id`, `is`, `it`, `ja`, `ko`, `lt`, `lv`, `ms`, `nb`, `nl`, `pl`, `pt-BR`, `pt-PT`, `ro`, `ru`, `sk`, `sl`, `sr-Latn`, `sv`, `th`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`. Keep Brazilian Portuguese (`pt-BR`) distinct from European Portuguese (`pt-PT`), and Simplified Chinese (`zh-CN`) distinct from Taiwan Traditional Chinese (`zh-TW`). `sr-Latn` is Serbian in Latin script, `ca` is Catalan and `ms` is Malay. `sk` is Slovak; `nb` is Norwegian Bokmål. Selection uses exact catalog codes; unknown codes fall back to English.
- The bundle carries `direction` from the selected language: Arabic (`ar`), Hebrew (`he`) and Persian (`fa`), including regional variants, use `rtl`; other current languages use `ltr`. Keep the initial HTML and later login/session updates consistent. Direction never changes saved workspace geometry or file/terminal bytes.
- Flat dotted keys name the domain and precise meaning, such as `error.fileExists`; avoid ambiguous words, sentence fragments, numeric suffixes and keys containing policy limits. Reuse only when meaning/context match.
- Fixed repository identifiers such as `agent0ai/tuxee` remain literal; do not create translation keys for them. Translate surrounding descriptive labels normally.
- Named `{variables}` are single-pass plain-text substitutions. Supply counts, limits, sizes, versions and names from the owning code/constants; never bake changeable values into translations. Keep complete sentences in catalogs, not concatenated translated fragments. Matching keys have identical variable sets in every built-in language.
- Built-ins are embedded once. `/etc/tuxee/i18n/<code>.json` overrides built-ins by key or adds languages; overrides may omit `name` for existing languages and omit any texts. No per-user directory. Effective English is the fallback, then selected-language texts win. Ship one merged dictionary, including every dynamic key; never embed all languages in generated JavaScript.
- System files must be regular non-symlink files, at most 2 MiB each, 16 MiB combined and 256 directory entries. Invalid files are logged/skipped. Refresh at startup, login or explicit login-language selection; reuse cached bundles while unchanged. Existing authenticated bundles never mutate. Restart exposes added files immediately on the initial login page.
- Missing keys or required variables return a visible plain-text placeholder such as `[!files.renameFailed name="report.txt"]`, with sorted JSON-escaped variable values. They never throw. Invalid custom locale identifiers fall back to English for date/number formatting without changing the selected text dictionary. No HTML interpolation, eval, recursive variable replacement or compiled-script rewriting.
- `Message` transports `{key, vars}`; variables may contain nested Messages. `New`/`Wrap` preserve typed errors/causes, `Describe` translates known native errors, and `From` preserves worker metadata. English diagnostic strings remain available. Do not translate user filenames/labels, shell/GUI output, external tool diagnostics or standalone CLI logs/help.

# Work Guidance

Read each text's caller and UI context before translating: action versus title, current state versus command, target object, available space and variables. Use natural native wording. For languages with sensitive count/case/gender forms, prefer robust neutral phrasing (`Soubory: {count}` in Czech); keep ordinary English one/many keys when appropriate. Do not copy English as a substitute for a translation. Keep accessibility labels and errors equally complete. Use count-neutral wording where declension or plural categories require it, including Slavic, Baltic and Arabic languages. Check narrow dialogs and mixed-script text with fonts covering each script; never ship test-only font collections. Review short actions explicitly (Save, Close, Paste, Move) and distinguish terminals, shells and process descendants from everyday meanings.

Aim for similar rendered length to English, especially on short buttons, tabs, column headings and status labels. Shorter translations are fine. Prefer a concise natural command over an instructional sentence; omit redundant context only when the surrounding UI supplies it. Never remove meaning, destructive-action distinctions or accessibility context just to satisfy a length target, and avoid cryptic abbreviations. Workspace labels use a compact local equivalent of desktop/space (`Desktop`, `Plocha`, `Spazio`, `Espace`), with matching grammar throughout menus and notices. Check generated tab names with two-digit numbers at 320px/390px widths. Saved workspace names are user data; catalog wording changes apply to new defaults and must not rename existing workspaces.

After every UI/text/backend-notice change, update every built-in language and run `npm run check:i18n`. Review its advisory length warnings and full `test-results/i18n-length-report.json`: only longer translations warn, at ≥75% expansion and ≥8 extra graphemes for English texts up to 30 graphemes, or ≥100% expansion and ≥20 extra graphemes for longer texts. Each named variable counts as one grapheme; combining marks do not inflate the count. The report includes both texts, lengths and percentage increases, with the ten largest increases in the console. It is a review aid, not a pixel measurement or a reason to damage natural language; warnings do not fail checks. Add new built-in language codes to the checker's required list. The frontend build enforces completeness; targeted source lint complements review and cannot prove every runtime path is localized.

# Verification

`npm run check:i18n` checks required catalogs, duplicate/extra/missing keys, named-variable parity, literal references, CSS text and obvious hardcoded UI/text selectors. `node internal/i18n/check.mjs --self-test` tests failures. `go test ./internal/i18n ./internal/server ./internal/terminal` covers layers, fallbacks/placeholders, worker/engine metadata, snapshot freezing and injection safety. `npm run test:i18n` covers the production browser/session path and all built-in languages at desktop/390px/320px widths, including RTL direction, mixed-script editor/PTY bytes and direction-aware tab reordering.

# Child DOX Index

No children.
