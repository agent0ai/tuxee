Build and validate a working proof-of-concept of Tuxee in /workspace/tuxee: a Linux
  management helper delivered as a Go executable with an embedded web UI for files, persistent
  terminals, virtual workspaces, and user settings.

  Complete the implementation, build the binary, run it on this system with dedicated Linux test
  users, and exercise the real application in a browser. Continue autonomously through
  implementation and debugging. Make reasonable prototype decisions and document them; ask only
  when a genuinely blocking decision cannot be resolved from these instructions.

  1. Preparation, reuse, and DOX

  Read /workspace/tuxee/AGENTS.md and follow DOX properly throughout the work. Read the complete
  applicable parent/child instruction chain before editing. Create child AGENTS.md files when
  durable ownership boundaries emerge, maintain their indexes, and document actual contracts and
  verification commands. Preserve the user's root-cause and GitHub credential-handling agreements.

  Inspect and reuse as much suitable code as possible from:
  - /workspace/8020/https — the8020/https
  - /workspace/8020/dev-core — the8020/dev-core
  - /workspace/8020/kernel — the8020/kernel

  Check current upstream versions where relevant without altering those existing working copies.

  Trace the complete ownership of TLS, certificate issuance, terminal processes, display recovery,
  authenticated routing and WebSocket transport. Reuse existing code, dependencies, and proven
  contracts rather than recreating them. Preserve licenses and attribution.

  Adapt the useful parts to a single-host application. Avoid importing the entire 8020 database,
  distributed runtime, or sandbox infrastructure merely to reuse a small feature. Explain material
  reuse limitations honestly.

  2. Executable and deployment model

  Build a Go executable with embedded production frontend assets. Prefer a simple architecture and
  minimal dependencies. Document required Linux facilities and libraries, including PAM; do not
  claim a fully static, dependency-free executable unless that is actually achieved.

  The native installation manages the host's real users, files, and processes. A Docker deployment
  manages its container environment by default. Keep that distinction explicit.

  Provide a Dockerfile and minimal runnable example using a Bash loop to restart the executable
  one second after any exit, with Tini for PID 1 signal forwarding and orphan reaping.
  Stop restarting on shutdown and terminate active process groups. Keep Node/npm in build stages.
  Persist necessary configuration and certificate state. Use the documented Docker-only
  account defaults; normal container operation must not require privileged Docker access.

  Docker alone launches `/init/*.sh` independently in parallel on each container start in a
  separate background job alongside Tuxee, without automatic restart or an execution order guarantee.
  Scripts may run indefinitely; a blocked or failed script must not stop Tuxee or sibling scripts.
  Include `/init/README.md` with examples for foreground services and restart loops.
  Log failures, wait for active scripts, and terminate their process groups on shutdown.
  Persist the folder in the Compose example.
  Native installations never run these scripts.

  3. Service installation and lifecycle commands

  Provide convenient CLI commands, including:
  - tuxee serve
  - tuxee service install
  - tuxee service uninstall
  - tuxee start
  - tuxee stop
  - tuxee restart
  - tuxee status
  - tuxee logs
  - Help and version output

  Use systemd for native service registration where available. Installation should create the
  appropriate unit and enable startup at boot, using a stable executable path and explicit
  configuration/state locations. Clearly report whether the service is running and how to start
  it.

  Make repeat installation safe. Never overwrite an unrelated unit. Uninstall should remove
  service registration without deleting users' files, configuration, or certificate state.

  Use the actual service manager for lifecycle commands; do not build a competing daemon
  supervisor. On systems without systemd, explain the limitation clearly while retaining
  foreground and Docker operation.

  Test lifecycle commands using a dedicated prototype service identity. Do not disrupt existing
  services, change host SSH configuration, or reboot the machine to prove startup enablement.

  4. Authentication and Linux permissions

  Allow Linux users to sign in with their real username and password, subject to the host's PAM
  authentication and account policy.

  Use passwords only transiently for authentication. Never persist them in configuration,
  databases, browser storage, logs, command arguments, or environment variables. Subsequent access
  uses revocable application sessions.

  Run file operations, command execution, and terminal processes with the authenticated user's
  UID, GID, and supplementary groups. Let Linux enforce filesystem permissions and ACLs. Start
  the first default file browser at `/` and a second at the user's home directory (`/root` for
  root), while allowing navigation elsewhere when Linux permissions permit. Preserve saved paths.

  Use process isolation for user credentials; do not switch the identity of a shared multithreaded
  Go server per request. Keep privileged authentication/process-launch responsibilities small and
  explicit.

  Enforce user isolation on every file, workspace, and terminal operation. Include
  appropriate session-cookie protection, CSRF/WebSocket-origin checks, and bounded login attempts.
  Logout must revoke browser access and detach existing browser terminal connections.

  Store user settings and layouts per user, with appropriate ownership and permissions. Keep
  server secrets and certificate keys separate.

  5. HTTPS and certificate fallback

  Plain HTTP opened on the HTTPS listening port returns a redirect to HTTPS on that same
  host and port, preserving the path and query. Keep this a small wrapper around the existing
  TLS server; never serve application endpoints in plaintext unless --http was explicitly set.

  Keep built-in HTTPS. Prefer automatic public certificates using TLS-ALPN-01 on public port 443,
  avoiding a mandatory port 80 listener. Support public DNS names and public IP certificates using
  a suitable existing Go ACME implementation and the existing repos' relevant policies.

  Certificates are independent of the UI's listening port. Default ACME issuance accepts public
  domains discovered from TLS SNI without requiring configured hosts. Optional hosts enable startup
  issuance and select the no-SNI identity; otherwise startup uses discovered interface addresses.
  Public TCP 443 must forward unchanged to the TLS listener for validation on any local port.
  Perform periodic renewal of tracked names without browser visits, with bounded retries after failure.

  When no valid public certificate is available, automatically serve a locally issued certificate
  so Tuxee remains available over TLS. Persist the local CA and renew its leaf certificates
  automatically.

  Continue using a public certificate while it remains valid, even if renewal attempts fail. Fall
  back when no valid public certificate remains, continue bounded public-renewal attempts in the
  background, and switch back when successful.

  Show clear certificate status and useful local-CA trust instructions. Do not promise that
  browsers will trust local certificates automatically. Leave HSTS off by default for this
  fallback mode and explain that inherited/cached HSTS policies can still affect access.

  Provide explicit HTTP operation for loopback, protected reverse-proxy connections, or
  deliberately configured deployments. Do not silently change transport to HTTP when certificate
  issuance fails.

  6. Persistent web terminals

  Reuse the existing xterm frontend, terminal lifecycle, display recovery and WebSocket
  transport as far as practical. Start local PTYs directly under the authenticated Linux user.

  A terminal's running process must be independent of the browser connection and web login
  session. Preserve terminals across workspace switches, navigation, reload, network loss, mobile
  suspension, and logout/login.

  Keep stable session identities and restore the terminal display correctly, including interactive
  programs, resize behavior, Unicode, and alternate-screen applications. Do not substitute raw
  output-tail replay for correct terminal recovery.

  Expire terminals after a configurable number of hours with no authenticated browser
  attachments. Store the timeout preference per user. Background output and internal display
  processing must not extend that deadline.

  Reuse the existing single-controller/takeover behavior for concurrent attachments. Bound
  scrollback, buffers, and resource use.

  Expose terminals only through the web UI. Do not run an SSH attachment/proxy service or
  publish an SSH port in Docker; terminal management does not depend on SSH.

  Distinguish closing a view, detaching a session, explicitly terminating a terminal, and stopping
  Tuxee. Service-restart or host-reboot survival of live processes is not required for this
  prototype. Restore saved layouts honestly and mark sessions that ended.

  7. Virtual workspaces and default layouts

  Create the first virtual workspace on first login. Select its default layout from the current
  screen shape, persist it, and resume that workspace/layout on later logins.

  Default regular desktop layout:
  - Left half: two file browsers stacked vertically, `/` above the signed-in user's home.
  - Right half: one full-height terminal.

  Default ultrawide layout:
  - Four columns from left to right.
  - Cells 1 and 2: file browsers at `/` and the signed-in user's home directory, respectively.
  - Cells 3 and 4: separate terminals.

  Support multiple named virtual workspaces with independent layouts and component state.
  Switching workspaces should use a short, subtle slide animation and preserve running processes.

  Closing a workspace requires confirmation explaining that its terminal processes will stop.
  Stop every terminal associated with that workspace in the background, including sessions still
  starting. Browser closure and logout only detach, allowing reconnection until idle expiry.

  8. Responsive desktop grid

  Implement a real interactive docking/grid layout. Users can move and resize components and drop
  a component at another component's edge to split the space above, below, left, or right.

  Display a clear drop preview. Keep layouts valid and bounded, without overlapping, disappearing,
  or unusably tiny panels.

  Maximum grid dimensions:
  - Regular landscape: 4 columns × 2 rows.
  - Portrait desktop/tablet: 2 columns × 4 rows.
  - Ultrawide: 8 columns × 2 rows.
  - Mobile: one visible component, without a desktop grid.

  Enforce limits across the whole layout, including repeated splits. Define sensible breakpoints
  and minimum component sizes. Handle smaller viewports without destroying the saved desktop
  arrangement.

  Clicking an add button should place a component using a predictable, compact expansion strategy
  with minimal disruption to existing panels. At capacity, provide a clear alternative such as
  another workspace.

  Prefer a suitable existing docking/grid implementation when it materially reduces code. Avoid an
  unnecessarily elaborate custom layout engine.

  9. Top bar and mobile navigation

  The top bar contains:
  - A file-plus icon and terminal-plus icon on desktop (in the component strip on mobile).
  - Virtual-workspace tabs.
  - A button to create a workspace; desktop tabs include Close, while mobile tabs use a long-press menu.
  - Live CPU, RAM and root-disk gauges in the desktop header by default. On desktop and mobile, the account menu has only a plain Resource monitor button opening the modal, with no live gauges. Click for details with a configuration cog and a Display resource monitor switch. Save display visibility per user without clearing metric selections. Every account menu retains Resource monitor access, including when hidden, for live quick looks and re-enabling display. Stop background polling when display is off and the modal is closed, including while the account menu is open. Opening the modal resumes polling; closing it stops polling again when display remains off. Users can select CPU/RAM/swap, mounted local filesystems, network interfaces and a 2/5/10-second refresh interval, persisted per user. Hidden tabs pause polling. Containers use their cgroup limits/accounting; disk capacity refers to visible filesystems.
  - A light/dark switch, with dark mode as default.
  - Username and a hamburger menu containing Settings, About and Logout.

  Clicking the Tuxee logo or choosing About opens the same accessible modal with the full vertical logo and no visible heading
  and a formatted table of the Tuxee version, operating system, kernel, architecture, server
  name and signed-in user details. Support both themes and compact viewports.

  Clicking a plus icon creates a component in the current workspace. On desktop, users can also
  drag the plus icon into an exact grid position.

  On mobile, display exactly one component using the available screen area. Provide top tabs to
  switch between file browsers and terminals, and controls to add more of either. Keep workspace
  switching available without overcrowding the narrow screen.

  Use keyboard/OS clipboard controls without an on-screen terminal modifier row. Adapt to the
  onscreen keyboard and preserve terminal state during orientation changes.

  10. File management

  Implement real file browsing with navigation, selection, refresh, directory creation, rename,
  deletion with confirmation, uploads, and downloads.

  Support:
  - Drag-and-drop files and folder trees from the operating system, with one batch progress indicator (files and bytes), cancellation and collision-safe numbered names. Ignore drops outside accepting panels. Terminal drops upload into the signed-in user's ~/uploads and paste quoted paths without Enter. Native clipboard image/file paste uses the same flow; preserve normal text paste and avoid clipboard/path hacks.
  - Transfer progress, cancellation, and understandable errors.
  - Dragging files between independent file browsers.
  - Move/copy modifiers with a visible operation indicator and destination preview.
  - Explicit move/copy controls for touch and keyboard users.
  - An Open terminal here toolbar button that opens a terminal panel in the browser's current directory.
  - Context menus through right-click and an accessible touch/button alternative.
  - A properties modal showing attributes, ownership, permissions, timestamps, and size.
  - Permission changes where the authenticated Linux user is authorized.

  Define copy/move defaults clearly. Handle collisions and partial failures without silently
  overwriting or losing data. Stream large transfers rather than buffering entire files in memory.

  File browsers do not contain command rows or embedded terminals. Use independent terminal panels.

  11. Design and accessibility

  Make the UI modern, minimal, and polished. Use restrained spacing, clear typography, coherent
  icons, and concise animations that communicate state without delaying work.

  Provide light and dark themes, visible keyboard focus, useful empty/loading/error states,
  accessible labels, and reduced-motion support.

  Prioritize working interactions over decorative mockups. Persist themes, workspace layouts,
  component directories, and relevant terminal references per user. Never save credentials in
  browser state.

  12. Validation and completion

  Build and run the actual binary on this system. Create clearly named, dedicated test users with
  different filesystem permissions and groups. Keep their credentials out of logs and committed
  artifacts.

  Use browser automation against the real Go server and real Linux processes. Test desktop,
  portrait, ultrawide, and mobile viewports. Do not treat a mocked frontend or viewport
  screenshots alone as end-to-end validation.

  Verify:
  - Successful/failed login, user isolation, permissions, and logout revocation.
  - Terminal process identity across reload, logout/login, workspace switching, and reconnection.
  - Browser attachment/reconnection, controller transfer, and interactive programs.
  - Detached-session expiry using short test timeouts, including ongoing output.
  - Grid splitting, resizing, previews, limits, add controls, persistence, and mobile navigation.
  - File operations, denied operations, uploads/downloads, progress, cancellation, and cross-
  browser copy/move.
  - Theme/settings persistence, keyboard file navigation, and tab overflow.
  - TLS fallback, persisted certificate state, and live certificate switching where testable.
  - Service install/start/stop/restart/status/uninstall behavior.

  Use ACME staging or a local test CA for automated issuance tests. Do not consume production
  issuance limits just to test. If external validation or Docker cannot be exercised here, state
  that precisely.

  Investigate browser-console errors, stalls, reconnect loops, memory growth during transfers, and
  interaction failures. Fix root causes and add small meaningful regression tests at their owning
  layer.

  Finish with:
  - The built executable and exact launch commands.
  - A running prototype URL when the environment permits.
  - Test account usernames and instructions for setting their passwords.
  - Service-installation and Docker usage instructions.
  - A concise account of code reused, checks passed, and remaining limitations.
  - Current DOX documentation matching the implementation.

  Do not claim production readiness. Deliver a genuinely usable prototype with the requested
  interactions and real Linux behavior.

13. Frontend delivery (user clarification)

Do not rely on external frontend runtime libraries, CDN assets, fonts or scripts. Ship all required dependencies locally. Prefer one fast bundled production index file while retaining separate source styles and modules for editing. A separate locally served service worker is acceptable where the browser requires a script URL.

14. Interaction refinements (latest user instructions)

Keep existing panels mounted during layout edits. Closing one component animates only that component; neighboring panels stay in place. Workspace switches render complete adjacent layouts and slide horizontally in the direction of the selected tab.

The whole panel header moves the original component using pointer dragging, preserving its grab offset. When the cursor is over another panel, use its position to select that panel and the left/right/top/bottom split or center swap. This takes priority over empty placement unless a grid target spans both vacant and occupied cells. In empty space, use the cursor over the background grid to select a 1×1 cell, 2×1 horizontal pair, 1×2 vertical pair or 2×2 square at a crossing. Resize to that exact preview independently of the dragged window's previous size or grab offset. If the target overlaps another window, shrink that neighbor to its largest remaining rectangle, with a minimum of one cell in each dimension. Reject the drop if any neighbor cannot remain; never relocate unaffected windows or split/remove a neighbor. Targets spanning vacant and occupied cells work from either side of the boundary. The moving window's old cells are available. Show those vacancies during dragging. Keep all grid cells and workspace highlights below every window; make the dragged window 60% opaque so the target is visible through it, and restore full opacity on drop or cancellation. Apply the same rule to dragged add buttons. Outer screen-edge snapping remains available. Valid drops animate from the release position into place; invalid drops/cancellation animate back. Resize corners use small diagonal strokes overlaid on content; content extends to the bottom.

Remove descriptive/promotional microcopy from login and the application. Terminals have one header with rename and close, no second status bar, separate terminate button or bottom modifier row. Closing a terminal panel terminates its process. Closing a workspace confirms and terminates its terminals in the background; its desktop close button is inside its tab, while mobile closure uses the tab context menu. The username and hamburger form one button with an anchored menu below it.

File drops support copy/move modifiers, whole-panel destinations and visible arrival animation. Dropping a file into a terminal inserts its shell-quoted path without executing a command. Terminal surfaces may remain dark to preserve application-defined colors.

Compact/mobile mode is a viewport decision independent of the workspace layout. Mobile shows flush content with names/controls in component tabs, no panel frame or duplicate title bar. Theme/account controls align right, and the account menu includes the username. Workspace and component tabs fit using the8020/uui header overflow behavior; excess items live under a three-dot anchored menu, never a horizontal scroller.

File browsers and terminals have desktop rename icons and mobile Rename menu actions. Persist file-browser display-name overrides per user without changing filesystem names; retain them across navigation. A Reset button in rename dialogs restores the current-folder label (Files at `/`) or the session name Terminal.

All context menus appear at the click position or invoking control. Up/Down navigates them; Escape closes them and restores focus without deselecting files. File navigation supports Up/Down, Right into folders, Left to the parent, Space selection, and Alt/ContextMenu/Shift+F10 for actions. Confirmations focus the confirming action so click + Enter confirms.

Multi-selection properties show total selected-entry size, common values or Multiple, ownership, timestamps, and editable permissions. With no selection, Properties opens the current folder, including `/` and empty folders. Offer it in the directory-background context menu and through the footer info button. Permission application can partially succeed under normal Linux permissions. Copying into the same directory creates collision-safe sibling names without overwriting originals. Component notifications and transfer progress appear in the originating component; global notifications use the viewport corner.

15. File tools and workspace refinements

Use existing, locally vendored CodeMirror 6 for editing, with bundled syntax modes and extension-based selection. Provide image/PDF viewers with previous/next navigation, HTML audio/video playback, and native-tool compression/extraction with optional passwords. Preserve user permissions, reject stale saves and confirm before discarding edits. No external runtime libraries or CDN requests.

File lists reveal an editable, focused footer filter as the user types; a footer button also opens it for touch input. Escape clears/closes the filter and Enter/Up/Down returns to the list. Name/Size/Modified headers cycle ascending, descending, default, showing active ▲/▼ indicators. Keep the selected sort across folder navigation; default to folders first, then names. Shift+Up/Down extends/shrinks selection. Background clicks clear selection. Mouse drags from the margins or stats draw a selection rectangle with a 12%-opacity fill and edge auto-scroll; intersecting any part of a row selects it, including its right side; modifier keys add to selection and Escape restores the previous selection. Item clicks select and double-clicks open from anywhere in a row, including its middle, stats and far edge. File drags still start only on names/icons; moving from other row areas starts rectangle selection. Touch retains native scrolling. New file and New folder are available in the toolbar and background context menu, not item menus. New files must never overwrite existing paths. Group dragging represents every selected file/folder. Same-browser moves do nothing; copies create distinct siblings or copy into the chosen folder. Show a subtle Ctrl-to-copy hint with Move targets. Copy/Move labels and hints belong only to file-browser drop targets, never the dragged group or terminals. Retained terminals include detached sessions only, without IDs.

Place workspace plus after the visible tabs. On desktop, group file-add, terminal-add and rearrange before the theme control, with separators and spacing. On mobile, place file-add and terminal-add after the component tabs/overflow in their own strip, always visible, freeing the top bar for workspaces. Left-align overflow component icons/names. Mobile component and workspace tabs have no inline rename/close buttons. Long press visible or overflow tabs for Activate, Rename and Close, reusing right-click and keyboard menus. Cancel pending holds on movement/scroll/cancellation/disposal and consume release clicks without activating the tab or an action. Preserve terminal Take control access in its menu. Rearrange compares actual pixel shapes, preferring horizontal terminals and compact file lists. Group files on the left and terminals on the right; in portrait prefer files above terminals. Allow stepped type boundaries when they recover usable space. Balanced targets more space per terminal, keeps reading room for both types where possible, centers spare side space and retains width caps (files 640px, terminals 1440px at grid resolution). Terminal priority initially packs files into single cells and maximizes terminal area; file priority initially packs terminals and maximizes file area, favoring full-height file lists. After calculation, expand every panel into the largest free rectangle containing it, with the priority type first, preserving width limits and never shrinking panels or moving/covering neighbors. Non-priority panels retain the normal 640px file/1440px terminal width caps at grid resolution. Lift pixel width caps for the chosen type in priority modes, but cap file browsers at two cells wide in all automatic layouts. Apply the cap during arrangement and center any spare side space; do not restrict manual/custom widths. Modes may coincide when available space and width limits yield the same useful geometry; do not minimize components just to distinguish modes. Cycle Balanced → terminal priority → file priority → the original custom geometry, persisting the mode and per-ID geometry across reloads. Restoring must preserve current file paths and terminal sessions. Rotate an asymmetric local icon clockwise by 90° per click, with upright for custom. On click, smoothly expand the button to show its current label: Balanced, Terminals, Files or Custom. Keep the label while hovered, collapse two seconds after pointer leave, and cancel collapse on re-entry. Activation without hover also times out after two seconds. Keep current/next mode in the accessible description, remove the native tooltip, respect reduced motion and clear timers when the header is disposed. Manual moves, resizes, expansions, additions and removals reset the cycle; cancelled gestures do not. Hide the button on mobile. Put type icons in desktop titlebars and mobile tabs, preserve them on label changes, and separate visible mobile tabs with faint vertical pipes. Screen-edge half/quarter snapping previews the entire target and reflows neighbors within bounds. Double-click titles to expand into surrounding free cells without moving or covering neighbors; if blocked in every direction, shrink to one cell. Animate resize width/height from the live released rectangle to its grid size. Drag shared gaps to resize all adjoining panels together, including three/four-panel junctions. Preserve integer grid snapping and one-cell minimums, clamping each axis independently. Hide locked handles and all handles in mobile view. Keep mounted content stable, support divider arrow keys, and restore original geometry on cancellation.

Docker creates no tuxee user; it initializes root from the runtime `ROOT_PASSWORD` environment variable on each new container's first start, defaulting to `toor` when unset, and persists the root home. Restarts preserve subsequent password changes; container recreation initializes the new account database again. Initialize before services/hooks, reject empty passwords and line breaks, mark success only after the update, and remove the variable from child environments. Do not alter the host root password while implementing/testing this image configuration.

Explicit panel/workspace closure kills associated terminals in the background, including pending creations and inactive workspaces; kill failures do not block closure. Browser closure, workspace switching and logout retain terminals. The file action is named Properties. Internal pointer drags use Control/Command/Option for Copy and verify actual filesystem results; native uploads remain supported. Docker login shells reuse the8020/kernel green user/host and blue directory prompt through a system login profile, allowing user startup overrides.
