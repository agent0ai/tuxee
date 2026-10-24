Framework source: [agent0ai/dox](https://github.com/agent0ai/dox/blob/765ae4ac02cc884eefcd41a3d0f71941721adb89/AGENTS.md).

# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

- Use `main` as the primary Git branch.
- Root `LICENSE` uses Agent Zero's MIT license with Tuxee's repository URL (`https://github.com/agent0ai/tuxee`); preserve separate third-party licenses and reuse notices.
- Tuxee is developed in-house. `CONTRIBUTING.md` politely asks others not to open pull requests; critical security fixes are the only accepted external contributions.
- The frontend ships all dependencies locally. Production bundles into one fast index file, with separate source modules/styles for editing and only required local worker and public branding assets separate.
- Compact mode depends only on the viewport. Use click-position/anchored context menus, local component notifications, and three-dot tab overflow. File browsers have no embedded command terminal.
- Keep the UI free of promotional/descriptive microcopy except the About tagline. Panel edits preserve neighboring views; workspaces slide as full layouts. Closing a terminal panel terminates its process; workspace closure confirms and terminates every terminal in that workspace in the background.
- Use the exact tagline `Tuxee - the most convenient linux for servers and agents.` in the README title, CLI help banner and About subtitle below the logo.
- Keep the root README ordered as the centered vertical logo, project title, short container/standalone introduction, Highlights, Quick start, Resources links, then Agent Zero credits/community links. Quick start recommends zero-configuration Docker first, with port mapping matching the image, browser/login details, password-change guidance and `ROOT_PASSWORD`; then show native installation and the manual-install link. Highlights uses an alternating image/text HTML table with descriptive titles and thumbnails linking to full images with `target="_blank"`, starting with the lightweight metrics infographic, then login. Use WebP for screenshots and lightly compressed JPG for the infographic. Keep only their optimized images and thumbnails in `.github/resources/screenshots/`; do not retain duplicate originals in `assets/`. Keep original logo artwork in `assets/`, detailed documentation in `docs/` and Docker support files in `docker/`. Keep build outputs, dependencies, local state and editor/OS clutter out of Git.

- The README's centered vertical logo selects the transparent dark web asset for dark mode and the transparent light asset otherwise.
- Stable version tags publish Linux amd64/arm64 binaries and matching Docker Hub images, with version-named GitHub releases and commit-based notes. Use a checksum-verified installer and explicit `tuxee update`; never restart automatically. About checks versions and shows a terminal command, with update warnings on About and the hamburger. Check at startup and daily at 00:01 in the server timezone.
- Go and Docker builds default to version `0.0.0` when no version is injected; release builds use their Git tag.
- The install script also upgrades existing default installations, including releases without `tuxee update`. Use the downloaded binary's installer, preserve configuration/state, and leave restarts explicit.
- `tuxee upgrade` is an alias for `tuxee update`, using the same handler and options.
- `tuxee restart` noninteractively requests the same runtime cleanup/re-exec as the UI, under the caller's Linux signal permissions. All systemd lifecycle commands live under `tuxee service start|stop|restart|status|logs`. Identify running installations with root-owned, atomic records in `/run/tuxee`, published only while restart is available; validate boot and process-start identity and signal through a pinned proc descriptor. Match the executable installation path across binary replacement; `--name` selects a managed installation and `--state` disambiguates multiple matching instances. Never guess or signal an older server without a record. Remove records before cleanup and ignore late restart signals across re-exec.
- Update notices and CLI restart hints use `tuxee` only when PATH lookup and symlink resolution match the target installation path; otherwise shell-quote the full executable path. CLI update results have a blank line, green success or red failure, another blank line, the restart/terminal-termination disclaimer, then `Restart using:` with the command in yellow. Failures remain nonzero; updates never trigger restart. Omit ANSI colors outside a terminal, with `NO_COLOR`, or with `TERM=dumb`.
- Every signed-in account has Restart Tuxee immediately above Log out. Authorize through a credential-dropped Linux signal-permission check against the running Tuxee process; show failures without disrupting the runtime. Do not hardcode root-only access or elevate through sudo. Confirm that it ends every user's terminals/GUI apps and login sessions while Linux and unrelated services remain running; explain Linux `reboot` versus container restart/PID 1 according to deployment. Preserve unsaved-edit checks and settings. Reuse the disconnected loader, reloading the full page to fetch the current frontend and show login after readiness confirms the old session ended. The CLI drains HTTP and terminal cleanup, then executes the currently installed binary with the original arguments/environment and the same PID (pinning an initially ephemeral bind port); standalone, systemd and Docker need no separate restart mechanism, and Docker init hooks do not rerun. A shutdown signal during cleanup cancels the pending restart.
- Container upgrades run a separately tracked, embedded `internal/update/update.sh` on the next server start, with a completion marker outside data volumes. New images bake their version into that marker and skip setup. Record success only after completion; failures retry on the next start. Setup ensures the minimal audio runtime in existing Docker containers, without automatic restarts or native-host changes.
- Resource monitor process discovery and signalling run under the signed-in Linux user's credentials and verify stable process identity before signalling to prevent PID-reuse mistakes. Load processes only on request, with Refresh and server-side RAM/CPU sorting; RAM is the default. No background process polling; refresh once 500 ms after a kill attempt.
- Display a tree with `CPU (own)` and `RAM (own)`: the main value includes descendants; parentheses show only that process. Use inexpensive CPU counters and proportional anonymous/shared memory (PSS) for process RAM, prefixing aggregate RAM with `~`. Keep file-backed PSS separate in tooltips; fall back to explicitly marked anonymous/shared RSS estimates when proportional counters are unavailable, propagating estimates through totals. Keep the widget's existing non-reclaimable calculation; process totals need not equal it. Return at most 1,000 rows, with total-process footer information. Under a parent with more than 100 live children, show the top 99 and group the rest into one record. Zombies use count-only summary rows with no expansion or kill action.
- Process selection cascades to descendants, including grouped PIDs; deselecting a child deselects its ancestors recursively. Use an unchecked-by-default `Allow killing core` checkbox beside Refresh to opt into selecting/signalling PID 1, Tuxee and its ancestors while retaining Linux permissions and stable process identity checks. Reset the opt-in when the process view closes. Use one toolbar Kill button with an icon and a popup offering SIGTERM or Force kill, with deduplicated target/child counts and snapshot CPU/RAM totals. There is no children switch or per-row kill button. Do not promise reclaimed resources. Keep controls/copy minimal and use ordinary bounded rendering, including on phones and in container hierarchies.

- Only file browsers and terminals are components. Terminals lazily start their own X display when an application connects; the terminal icon/name is the first header button, followed only while GUI windows exist by a pipe and window buttons. Show the selected item’s name, collapse other items to icons and put excess windows in the existing three-dot overflow menu. When the optional audio runtime is available, audio is on by default. Use one browser-local audio volume control beside the theme switcher, with a compact vertical slider and mute/unmute; GUI window menus contain only window actions. The active GUI window has a chevron menu with Close; right-click opens the same menu and preserves application save/cancel prompts. Release empty display runtimes, return to the plain terminal header and restart lazily on the next GUI command. Preserve the shell and GUI across navigation/logout, and terminate both on explicit terminal closure. Remove the separate GUI launcher/component/API. Use Debian Trixie slim, minimal TigerVNC/Matchbox and locally bundled noVNC; keep Dockerfile builds usable and verify memory, real inputs and screenshots.
- Share one private PulseAudio runtime per Linux user across every terminal and GUI app, independent of X11 lifetime. Start it on the first audio connection. Use one shared capture per user and one mixed stream per browser, including retained terminals outside mounted workspaces. Omit only digital silence while preserving timing and first/quiet samples. UI mute/zero volume disconnects that browser; the last listener stops capture. Keep other users isolated and end the runtime after the last terminal ends. Minimize audio's Docker footprint through measured runtime builds; verify real playback and lifecycle before accepting a smaller dependency set.

## Child DOX Index

- [.github/AGENTS.md](.github/AGENTS.md): Version-tag release builds, commit notes, GitHub/Docker Hub publication, sponsorship configuration and README resources.

- [internal/AGENTS.md](internal/AGENTS.md): Linux identity, file operations, terminal lifecycle, transport, TLS, and service implementation.
- [web/AGENTS.md](web/AGENTS.md): Embedded frontend and browser dependency builds.
- [tests/AGENTS.md](tests/AGENTS.md): Real-system and browser integration checks.
- [third_party/AGENTS.md](third_party/AGENTS.md): Verbatim bundled dependency licenses.
- [docker/AGENTS.md](docker/AGENTS.md): Docker runtime files, example configuration and startup-folder documentation.
- [docs/AGENTS.md](docs/AGENTS.md): Installation, releases and user/developer documentation.
- [assets/AGENTS.md](assets/AGENTS.md): Original logo artwork and its optimized UI/README copies.
- Root owns README.md, LICENSE, CONTRIBUTING.md, install.sh, build/package configuration, CLI entrypoint, Dockerfile, compose.yaml and third-party notices.


## Tuxee purpose and requested scope

- Build a Linux management helper delivered as a Go binary serving HTTP/HTTPS and an embedded web UI with a file manager, terminals, and user configuration.
- Current phase: a built and locally validated prototype. The user has authorized local builds, dedicated Linux test users, browser testing, and isolated service lifecycle checks.
- Investigate reuse of `the8020/https`, `the8020/dev-core`, and `the8020/kernel` for automatic certificates, HTTPS routing, and retained terminals.
- Authenticate with real Linux usernames/passwords. Terminals and file operations must run with that user's UID, GID, and supplementary groups so Linux enforces permissions.
- Keep named terminal tabs and their running processes across navigation, disconnect, and web logout. Never expire terminals because of inactivity or detachment; logout revokes browser access independently. Warn in Retained terminals and on the hamburger button about running sessions absent from every workspace, with explicit reattach/terminate actions.
- Optimize phones and small screens, including terminal input and file management. Provide smooth interactions, drag-and-drop uploads, downloads, transfer progress, and light/dark themes.
- Native mode manages the host. Docker mode manages its container environment; no implicit privileged host access.
- Docker initializes root from runtime `ROOT_PASSWORD` on each new container's first start, defaulting to `toor` when unset; do not create a tuxee account. Restarts preserve password changes; recreation initializes the new account database again. This applies only to the image, never the host root account. Persist the container root home.
- Docker login shells reuse the8020/kernel development prompt: green user/host and blue working directory. Install it through /etc/profile.d; preserve user startup overrides and native host configuration.
- Docker launches `/init/*.sh` independently in parallel on every container start through a separate background runner alongside Tuxee, with automatic restart disabled. No execution order is guaranteed. Scripts may run indefinitely; a blocked or failed script must not stop Tuxee or sibling scripts. Run each through Bash as container root in its own process group, log failures, wait for active scripts, and terminate their groups on shutdown. Scripts may implement restart loops. Ship `/init/README.md` and persist `/init` in Compose. Native installations never run these hooks.
- Keep Docker lightweight: a Bash loop restarts Tuxee one second after any exit, without rerunning init hooks; stop restarting on shutdown. Tini runs as PID 1 for signal forwarding and orphan reaping. The final Debian 13 Trixie slim stage contains runtime dependencies and a stripped executable only; keep Node/npm, compiler/frontend dependencies in build stages and remove installation caches in the same layer. Retain the Bookworm Go builder so the shared CGO/PAM executable and exported native binaries preserve the Debian 12 compatibility baseline.
- Container deployment must work with built-in defaults, directly or behind a TLS-terminating proxy forwarding to HTTP 80. Require no per-domain origin, proxy-mode flags, ACME changes or host-mounted config. Default Compose keeps only data volumes; custom JSON and listener settings are advanced options. Preserve cross-site request protection and Secure cookies for public HTTPS.
- Minimize image size while retaining the current runtime packages and normal Debian package management. Remove install logs and generated package-database backups in the installation layer; preserve active package metadata, licenses and runtime data.
- Exclude tests, GitHub resources/automation, AGENTS.md files, documentation and original artwork from the Docker build context; retain all build inputs, runtime assets and third-party notices.
- Do not bundle or automatically install `sudo`, aliases or compatibility wrappers. Container root runs commands directly; users may install real sudo themselves.
- Independent listeners use `TUXEE_HTTP_PORT` (80) and `TUXEE_HTTPS_PORT` (443); zero disables that protocol. Flags override environment, which overrides JSON and defaults. Both zero refuses startup before state/TLS work. Each enabled listener serves the application directly; only plaintext HTTP sent to the HTTPS port redirects to HTTPS on that same host and port. Plain HTTP is for trusted networks/protected proxies. Preserve legacy single-listener `--bind`/`--http` but reject mixing with independent settings. The CLI owns parsing, all-or-nothing listener startup and the image healthcheck. See docs/guide.md for mapping, precedence and zero-configuration proxy deployment.
- `tuxee ports [--http-port N] [--https-port N]` shows or atomically updates the existing `/etc/tuxee/config.json`; `--config` selects another installation. Preserve other settings, ownership and permissions. Edit saved JSON independently of shell environment overrides, validate through the shared CLI configuration contract, reject disabling both listeners, and leave restart explicit. Show saved settings without claiming they reflect a running process; startup flags/environment still take precedence. Do not silently migrate legacy interface-specific listeners.
- Certificate automation discovers public domains from TLS SNI without requiring configured hosts, independent of the local listening port. Optional hosts enable startup issuance and select the no-SNI identity. Private IPs and localhost use local certificates; local CA certificates require client trust installation.
- Terminal access is through the web UI only. Use local PTYs; do not expose or retain an SSH attachment service or Docker SSH port.

## Root-cause changes

- Treat the component where an error surfaces as evidence, not automatically as the fix scope. Establish ownership from the contract and full data flow before changing code.
- Trace failures across their full ownership boundary before editing a caller. When several callers can encounter the same defect, fix the shared contract or implementation at its owning layer.
- Do not add caller-specific coercions, retries, fallbacks, compatibility shims, or duplicated logic merely to hide a defect in a shared subsystem.
- Change a caller only when it violates an already-correct shared contract. Add a regression test at the root cause and verify the affected end-to-end path.
- If the shared layer cannot solve a case without ambiguity or disproportionate complexity, explain that limitation before introducing an explicit special case.

## GitHub authentication

- When an explicitly requested GitHub operation requires authentication, use an already exported, non-empty `GITHUB_TOKEN` if one is available.
- Otherwise, locate the applicable `.env` file in the active repository or its enclosing project/workspace and import only `GITHUB_TOKEN` into the environment for that operation. Check these applicable `.env` files before reporting that GitHub credentials are unavailable.
- Treat `.env` files and token values as secrets. Never display, print, log, quote, diff, commit, or otherwise expose their contents or values in tool output.
- Never put `GITHUB_TOKEN` in a remote URL, a command-line argument, or persistent Git configuration. Keep it scoped to the authenticated operation and use a non-persistent credential mechanism.
- Do not modify the `.env` file while loading the token.

## Work guidance

- Prefer the smallest complete solution, existing patterns, and standard libraries. Avoid speculative abstractions and dependencies.
- Report findings and tradeoffs concisely; distinguish code inspection from checks actually run.

## Verification

- Go 1.26.10 or newer and PAM development headers are required. This environment has a verified Go toolchain at `.tools/go/bin/go`.
- Build the embedded frontend and terminal engine with `npm run build`; build the executable with `.tools/go/bin/go build -o bin/tuxee ./cmd/tuxee`.
- `web/dist/` and `internal/terminal/engine.js` are generated and ignored by Git. Run the frontend build before Go builds or tests on a fresh checkout; keep vendored frontend source and dependency licenses in Git.
- Run `TUXEE_SYSTEM_TEST=1 GOMAXPROCS=2 .tools/go/bin/go test -p 2 ./internal/... ./cmd/... ./tests` for backend/system checks. Use `npm run test:gui`, `npm run test:gui-clipboard`, `npm run test:layout`, `npm run test:dividers`, `npm run test:browser`, `npm run test:clipboard`, `npm run test:uploads`, `npm run test:tabs`, `npm run test:mobile`, `npm run test:mobile-files`, `npm run test:features`, `npm run test:monitoring` and `npm run test:processes` for frontend checks; run browser suites sequentially.
- Run `npm run test:audio` with the optional audio wrappers on PATH for real GUI-to-browser sound; see docs/audio.md for setup and the insecure HTTP variant.
- Run `npm run test:docker-init` for parallel Docker startup scripts and failure isolation. With Tini on PATH, also verify continuous hooks alongside the framework, clean/crash restarts and shutdown through the production entrypoint without a Docker engine.


Distribution verification: run `npm run test:installer`, `npm run test:updates`, `go test ./internal/update`, `python3 tests/setup.py` as root (see tests/AGENTS.md for the versioned server fixture), and `python3 .github/release-notes.py --self-test`. The update browser suite starts an isolated server and restores user settings. Use actionlint for `.github/workflows/release.yml`; actual Docker/registry publication requires CI.

## Prototype contracts

- Prefer public TLS-ALPN-01 through public port 443 on any local listener, with persistent local-CA fallback when no valid public certificate exists. Keep retrying public renewal; do not default HSTS on.
- Native process credentials enforce Linux permissions. Passwords are transient authentication input only.
- Explicit panel/workspace closure terminates its terminals in the background, including pending creation. Keep at most eight visited workspaces warm, including the active workspace, in first-visited FIFO order; revisiting does not reorder them. Switching within the cache keeps terminal connections attached. Eviction, browser closure and logout detach without terminating; terminals have no idle timeout, regardless of output. Only explicit termination, process exit, unrecoverable terminal failure or server shutdown ends them.
- Every workspace has exactly eight grid cells: 4x2 landscape (including ultrawide and square screens), 2x4 portrait, with at most eight components. Orientation changes transpose existing geometry without changing component identities/counts; same-orientation resizes only change cell pixels. New small/mobile/portrait workspaces start one file browser and one terminal; notebook landscapes use two stacked file browsers left and one terminal right; larger landscapes use two of each. Compact mode shows one component at a time. Convert legacy eight-column layouts without losing panels or terminal sessions; overflow goes to another workspace.
- Service restart survival is not required. Preserve layouts and report ended sessions honestly.
- Test with dedicated users, ports, and services; do not alter host SSH or unrelated repositories.

## Current implementation boundary

- Implemented and locally validated: PAM/per-user workers, filesystem operations, canonical retained PTYs, TLS lifecycle, HTTP/WebSocket sessions, bundled frontend with docking/files/mobile workspaces, and service CLI. The published amd64 Docker runtime with a locally built executable is smoke-tested for startup/restart, PAM login, terminal WebSockets and folder-size streaming; full Dockerfile builds and broader container lifecycle checks remain separate verification.
- Release/update fixtures, daily-check scheduling, live binary-replacement helper/PTY continuity and Chromium update notices are locally verified. Tag workflows and Docker Hub publication still need a real CI run.
- Backend race tests, real PAM/HTTP/WebSocket integration, Chromium desktop/mobile/portrait/ultrawide flows, transfer memory/cancellation, interactive terminal recovery, unit verification and installation safety pass. docs/guide.md documents exact commands and limits.
- This workspace has root and Chromium but PID 1 is `tail`, not systemd. A separate Docker sandbox is available through the socket and localhost forwarding helper documented in the workspace AGENTS.md. Live systemd execution and public Internet ACME validation remain unverified. The prototype is not production-reviewed.
