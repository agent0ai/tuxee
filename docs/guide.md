# Tuxee guide

One Go executable with an embedded workspace for Linux files and retained terminals. Native mode manages the host's real accounts. Container mode manages the container's accounts and mounted files.

All frontend dependencies are shipped locally. Editable TypeScript and CSS stay separate; the production build embeds application JavaScript and CSS in one gzip-compressed `index.html` with a hash-protected inline script. Images load separately when needed from the same Go executable. Logo URLs contain content hashes so unchanged images stay cached across versions and changed images get new URLs; the page and unversioned resources revalidate on refresh. No CDN, external font or external script request is required. A small local `sw.js` handles streaming download progress.

This is a built, locally validated prototype, not a production release.

See [installation](install.md) for the installer, manual downloads and source
builds, or [updates and releases](releases.md) for GitHub/Docker Hub setup.

## Build and run

Follow [building from source](install.md#advanced-build-from-source) first.
Runtime needs glibc, PAM, host PAM configuration, NSS, `/dev/ptmx`, `/dev/pts`,
and each user's shell. The matched headless xterm engine runs inside Go through
Goja; Node is not required at runtime.

From the repository root, run a local prototype with no public certificate requests:

```sh
sudo ./bin/tuxee serve --bind 127.0.0.1:9443 \
  --state /var/lib/tuxee-poc --acme off
```

Open `https://127.0.0.1:9443`. Sign in with a Linux username and password. PAM authentication and account policy apply; non-login shells are rejected. Passwords are never stored by Tuxee. File operations and shells run with the user's UID, GID and supplementary groups. User layouts live in `~/.config/tuxee/settings.json`; server keys live under the separate state directory.

Each state directory also stores a random `instance-id`, created on first start and retained across restarts and upgrades. Tuxee uses `tuxee_session_<instance-id>` as its session cookie name, allowing multiple servers on different localhost ports to stay logged in independently. Login and logout affect only that instance. Give independent installations separate state directories or Docker state volumes. Preserve `instance-id` when restoring an installation; when copying state for a separate instance, remove the copied `instance-id` while that clone is stopped so it generates its own ID. Login sessions remain in memory and end when their server restarts. Cookie names prevent collisions; browsers still send cookies to every port on the same hostname.

Use `tuxee serve --help`, `tuxee help`, and `tuxee version` for CLI help. Defaults work both directly and behind a reverse proxy; no configuration file or public hostname is required. Terminal access is exclusively through the web UI; shells run directly on local PTYs.

## GUI applications in terminals

Build and run from the repository root:

```sh
docker build -t tuxee-gui-poc .
docker run --rm --name tuxee-gui-poc -p 8443:443 \
  -e ROOT_PASSWORD='your-test-password' tuxee-gui-poc
```

Open `https://SERVER-IP:8443`, accept the local test certificate, and sign in as `root`. Open a regular terminal and run `xterm` (or `xterm &` to keep its shell available). The component automatically shows the application. Click the terminal icon/name to return to its shell. While GUI windows exist, a pipe separates it from the window buttons. The selected item shows its title and an active border; other items show just their icons. Use the down arrow inside the selected GUI window’s outline or right-click any window button for Close. Drag window buttons to reorder them, or use Alt+Left/Right; the terminal stays first. Overflow entries reorder within their list. Window order lasts while the view remains mounted and resets on reload/logout. Applications can still show their normal save/cancel prompts. Excess windows move into the three-dot menu, keeping Close reachable. With no windows, only the plain terminal icon/name remains. The same controls appear above the body on mobile. Dialogs and file pickers stay in that display. Other apps must be installed first; xterm is included. No browser extension, public VNC port, GPU device or privileged mode is needed. Compose still selects the published image, so use the commands above to test this local build.

Only file browsers and terminals are component types. If reusing settings from the earlier GUI-component experiment, close those old GUI panels before switching builds; that experimental settings kind is intentionally removed. Existing file/terminal layouts are unchanged.

Sound is on by default for both GUI and command-line apps using PulseAudio. All terminals for the signed-in Linux user share one private audio server and one mixed stream per browser, including terminals outside the visible workspace. The speaker to the right of the theme switcher controls volume; unmute restores the previous level, and reload resets it to 100%. Mute or zero volume closes this browser's stream; the last listening browser stops capture. Other browsers and running applications are unaffected. If autoplay is blocked, a normal click or keypress unlocks sound. Audio starts on an application's first audio connection, without requiring a GUI window. GUI closure and workspace changes preserve audio; ending the last terminal stops the audio runtime. Digital silence sends no PCM packets while preserving timing and the first/quiet samples. Continuous stereo audio uses about 1.54 Mbit/s per browser over HTTP or HTTPS. See [audio measurements and reproduction](audio.md) for details and validation limits.

Each terminal receives a stable X display endpoint and private credentials before its shell starts. Tuxee initially allocates only Unix listeners and Go state. Its first GUI client connection starts one minimal Xvnc, Matchbox window manager and session D-Bus; simultaneous applications share that startup. Native window events update the header without polling. The shell stays mounted and running behind the display. Matchbox constrains dialogs to the current size, and noVNC resizes the actual display with the component.

Commands retain the shell's directory, environment and Linux UID/GID/groups. Navigation, reload and logout preserve both shell and applications. Two seconds after the last window closes, Tuxee stops Xvnc, Matchbox and D-Bus, returning their RAM. The public terminal endpoint and credentials remain, so the next GUI command starts a fresh display automatically. New connections to an empty display have 30 seconds to create their first window. Apps that hide all windows but retain X connections also lose the display after the grace period. Selecting the terminal releases the browser VNC connection/canvas without stopping applications. Closing the terminal/workspace, exiting its shell or stopping Tuxee closes the display and removes its credentials. Terminals retain their existing session limits and retained-session management. Display separation is not a filesystem/process sandbox. Applications that hand off to an existing process may need their new-instance option.

The GUI build and runtime use `debian:trixie-slim`; the Go builder stays on Bookworm to preserve Debian 12 compatibility for exported native binaries. `docker/build-gui.sh` builds checksum-pinned TigerVNC 1.16.2 and Xorg 21.1.25 without GLX/DRI/glamor or the native viewer. Only stripped binaries/licenses reach runtime. MIT-SHM is disabled because the local X proxy forwards bytes, not file descriptors. Go's XGB library handles native window metadata and activation; no extra window-watching process or `xprop` dependency ships. Browser assets and dependency licenses are bundled locally. Allow several minutes for the initial Xorg build.

On the tested arm64 host, 32 unused display endpoints used roughly 4–6 KiB of live Go heap/stacks per terminal and started no GUI processes. The browser test's active 2D display stack (Xvnc, Matchbox, D-Bus and its shell) used about 39–40 MiB summed RSS, with about 4–9 MiB additional Tuxee RSS after settling; the GTK test application used another 44 MiB. RSS counts shared library pages more than once; PSS was denied by this environment during authenticated tests. The display processes used 0–0.7% of one CPU across three-second idle samples; Tuxee used about 1% with its browser attached. These are indicative measurements, not fixed limits: resolution, activity, applications and Go collection affect them. After reclamation only the small prepared endpoint remains; no display processes stay warm. The last-window test confirms their summed RSS returns to zero; Tuxee itself retains its reusable Go heap.

For native installation, build/install the unique VNC binaries with `sudo sh docker/build-gui.sh /` after installing the GUI-stage build dependencies. Install runtime-stage GUI packages as well. Without `tuxee-Xvnc`, Tuxee retains ordinary terminals. Compilers, Python/GTK test fixtures, Node, websockify and a separate noVNC service are unnecessary at runtime.

Checks: `npm run test:gui` types commands through actual terminals and tests GTK/xterm input, modal parents, file chooser bounds, per-window activation, chevron/right-click Close including application confirmation/cancellation, selected titles, overflow and keyboard navigation, terminal selection, separate displays, resize, warm/reloaded workspaces, mobile, logout/relogin, empty display reclamation and lazy relaunch, shell exit and closure. It restores the marked account's settings and writes `test-results/gui-*.png` plus `gui-memory.json`. Requires root, Chromium and test-only `python3-gi`, `gir1.2-gtk-3.0`, `x11-utils`. `TUXEE_SYSTEM_TEST=1 go test -race ./internal/desktop ./internal/terminal ./internal/server` covers lifecycle/ownership/admission; `go test -run TestIdleDisplayMemory -v ./internal/desktop` with the same environment measures unused displays.

Trixie validation on arm64 includes the exact GUI-stage source build, exact runtime package installation, linked-library resolution, Tuxee startup and a native X11 window's creation/activation through the lazy proxy in a separate clean runtime filesystem (about 172 MiB of regular files including Tuxee, before the audio experiment). Docker layers/metadata are not measured. GUI-specific Docker/amd64 checks remain unverified here; the published amd64 runtime has been smoke-tested with a locally built executable for startup, PAM login, terminal WebSockets and file properties. No GLX/OpenGL acceleration, microphone forwarding or service-restart survival. Clipboard and incoming GUI file drops use the bounded bridge described below. Qt/Electron/full-desktop applications and physical mobile keyboards are not covered by these tests. Audio's separate host-build/browser measurements are documented in audio.md.

## Native service

```sh
sudo ./bin/tuxee service install --hosts admin.example.com
sudo ./bin/tuxee service start
sudo ./bin/tuxee service status
sudo ./bin/tuxee service restart
sudo ./bin/tuxee service logs
sudo ./bin/tuxee service stop
sudo ./bin/tuxee service uninstall
```

Installation copies the executable to `/usr/local/lib/tuxee/tuxee`, writes `/etc/tuxee/config.json` on first installation, registers `/etc/systemd/system/tuxee.service`, and enables boot startup. It reports whether the service is running; `service start` is explicit. Repeat installation preserves existing configuration and rejects unrelated units. Use `tuxee ports` for listening ports, or edit the existing configuration for other settings, then restart to apply. Uninstall unregisters the service and preserves the binary, configuration, certificate state and all user files.

Use `--name tuxee-poc` consistently to install/test a separate service identity. Its configuration, binary and default state paths use that name. Lifecycle commands delegate to systemctl/journalctl. Machines without a running systemd manager can use foreground or Docker operation.

`tuxee restart` requests the same runtime restart as the UI in foreground, systemd and Docker deployments. It is noninteractive and obeys the caller's Linux signal permissions; use `sudo` when needed. It identifies the running installation across binary replacement, supports `--name` for a named managed installation, and requires `--state /path` when multiple instances share that binary. It fails without changing anything when no matching instance is available. `tuxee service restart` separately asks systemd to restart the service, including starting a stopped service. Older running versions need one restart through the UI or their existing service/supervisor before the new CLI restart can be used.

Every signed-in account can choose **Restart Tuxee** immediately above **Log out** in the user menu. Restart requires the same Linux permission as signalling the Tuxee process directly; a denied request shows the error and a selectable `sudo tuxee restart` command when that short command names the installation, or its full executable path otherwise. The runtime and sessions keep running. The action does not invoke `sudo`. The confirmation explains that this restarts only the Tuxee runtime, ends every user's terminals and GUI applications, and signs everyone out. Unsaved editor changes require confirmation and saved layouts remain. The disconnected loader stays visible until Tuxee returns and confirms the session ended, then the browser reloads the page so login uses the current frontend. This works for foreground, systemd and Docker deployments, uses the currently installed executable, and leaves Linux, unrelated processes and Docker init hooks running. To restart Linux, use `reboot`; for containers, use the deployment's container restart controls or terminate the container's PID 1 as appropriate.

## Listening ports

`TUXEE_HTTP_PORT` and `TUXEE_HTTPS_PORT` select the actual listening ports in
both native and container operation. Unset values default to **80** and **443**,
respectively. Use decimal integers from **0–65535**: **0 disables that protocol**,
without an ephemeral socket or fallback to the default. Empty values, signs,
whitespace, malformed numbers and out-of-range values are startup errors.
JSON uses numeric `httpPort`/`httpsPort` (omitted or null means unset); flags are
`--http-port`/`--https-port`. Precedence is flags > environment > JSON > defaults.
Enabled HTTP and HTTPS ports must differ. Both zero makes `serve` exit with a
nonzero status and “no listeners configured”, before locking state or starting TLS.
The container's existing restart loop retries this invalid startup once per second;
use a stopped container when you want Tuxee to remain stopped.

```sh
# Both protocols: serve the app on HTTP 8080 and HTTPS 8443.
sudo env TUXEE_HTTP_PORT=8080 TUXEE_HTTPS_PORT=8443 tuxee serve
# HTTPS only: port 80 remains available to another service.
sudo env TUXEE_HTTP_PORT=0 TUXEE_HTTPS_PORT=8443 tuxee serve
# HTTP only, for a trusted network or protected TLS-terminating proxy.
sudo env TUXEE_HTTP_PORT=8080 TUXEE_HTTPS_PORT=0 tuxee serve
```

To view or change an existing installation's saved ports:

```sh
sudo tuxee ports                                  # Show saved ports.
sudo tuxee ports --http-port 8080 --https-port 8443 # Change both.
sudo tuxee ports --http-port 0                     # Disable HTTP; keep HTTPS.
sudo tuxee ports --http-port 8080 --https-port 0    # HTTP only.
sudo tuxee restart                               # Apply to the default systemd service.
```

`ports` reads `/etc/tuxee/config.json` by default and requires an existing regular
file. Use `--config /etc/tuxee-poc/config.json` for a named service, or the same
`--config` path used by your foreground server; restart that service/process
afterward. For foreground operation without a configuration file, pass
`--http-port` and `--https-port` directly to `tuxee serve` instead.

Only supplied ports change; other settings, ownership and permissions are
preserved, and the file is replaced atomically. Invalid ports, equal enabled
ports and disabling both protocols are rejected without modifying the file.
Legacy `bind`/`http` configurations must be migrated explicitly as described below.
The command reports **saved configuration**, not live sockets, and never restarts
Tuxee automatically. Restarting ends active terminals/GUI apps and login sessions.
After applying, reopen Tuxee at the new port; the old browser URL may stop working.
Environment variables are not copied into the file; startup flags and environment
still override the saved ports. Remove or update those overrides to use the new values.

Inside a container, run `tuxee ports` without `sudo`, then use **Restart Tuxee**
in the web UI or restart the container. The image's server and healthcheck both
read the saved configuration. This changes internal listening ports only; Docker
port mappings must target those ports. Edits in the container survive restarts,
but recreation restores the image's configuration unless it is persisted separately.

Independent listeners bind all interfaces and each serves the application directly.
The HTTP listener never redirects to HTTPS, whether HTTPS is enabled or disabled.
Only plaintext HTTP sent to the HTTPS listener redirects to HTTPS on that same
host and port, preserving escaped paths and queries. Docker/NAT may publish each
listener on a different external port; use that port in the browser URL.
Plain HTTP sends login credentials and session traffic unencrypted; use it
only on a trusted network or behind a protected TLS proxy. Direct HTTP cookies
are HttpOnly/SameSite=Strict without Secure, and terminals use `ws://`; direct
HTTPS cookies are Secure and terminals use `wss://`, including behind a
TLS-terminating proxy. See [reverse proxies](#reverse-proxies); no Tuxee settings
are required.

The existing `--bind ADDRESS:PORT` / JSON `bind` and `--http` / JSON `http: true`
retain their **single-listener** behavior (default address `:443`, TLS unless
`--http`). This includes legacy `--bind 127.0.0.1:0` for OS-assigned test ports;
it is separate from the new port settings' zero-as-disabled contract. Legacy mode
cannot be mixed with any independent port setting: startup gives a diagnostic
rather than ignoring a disabling zero. For a loopback-only proxy listener keep
`--http --bind 127.0.0.1:8080`; to migrate old JSON, remove `bind` and `http: true`
before adding port settings. Optional JSON configuration uses the new settings.
`service install` persists resolved environment/flag settings in its initial JSON;
existing service JSON is preserved. Later shell environment changes do not change
an already installed systemd service; use `tuxee ports`, edit its JSON, or change
its systemd environment and restart.

`tuxee healthcheck [serve options]` probes the preferred enabled listener (HTTPS
when enabled), with the same parsing and precedence. It sends only a local `/health`
request, checks status 200, and skips certificate trust verification for this
liveness probe only, as the image's previous curl probe did. It does not disable
TLS or alter browser/ACME verification.

## HTTPS

Opening `http://HOST:TLS_PORT` redirects to `https://HOST:TLS_PORT`, preserving the path and query. This redirect remains on the TLS socket even when `TUXEE_HTTP_PORT=0`; it opens no additional port. The separate HTTP listener (80 by default) and legacy explicit `--http` mode serve the application directly without redirecting.

Automatic public issuance uses TLS-ALPN-01, so port 80 is unnecessary. Public TCP 443 must reach Tuxee's TLS listener for validation. `--acme auto` (the default, also accepted as `on`) enables issuance and renewal on any local listening port. Any public domain pointing to the server can trigger issuance through the browser's TLS SNI; `--hosts` is optional. For example, forward public TCP 443 to local 4433 and run `tuxee serve --bind :4433`; no port override is needed. Forwarding must preserve the TLS handshake. Behind a TLS-terminating proxy, forward to the existing HTTP listener and let the proxy manage certificates; Tuxee needs no changes.

DNS names and eligible public IPs are supported. Set `--hosts admin.example.com` to request a certificate at startup, before the first browser visit. Without configured hosts, startup uses discovered interface addresses. For access by public IP behind NAT, set `--hosts PUBLIC_IP`: clients commonly omit SNI for IP addresses and Tuxee cannot infer an external NAT address. The first configured host is the no-SNI name. Private addresses and localhost use local certificates.

Until public issuance succeeds, Tuxee serves a locally issued leaf from a persisted CA, so the first visit can show a certificate warning. Existing public certificates remain in use until expiry despite renewal failures. Startup targets and background renewal of tracked names do not depend on browser visits. Retries continue at most once per hour per host when automatic issuance is enabled; `--acme off` disables them. Local leaves renew automatically. No transport downgrade and no default HSTS are used.

Settings → Connection follows the browser URL: HTTP shows **Plain HTTP**, including localhost; HTTPS through a TLS-terminating proxy shows **Encrypted HTTPS**. Direct Tuxee HTTPS includes its managed certificate details and offers the CA download only for a local certificate. Identifiable proxies hide backend certificate details even when they re-encrypt to Tuxee. Browser JavaScript cannot inspect the certificate issuer; a re-encrypting proxy that sends no forwarding indicators is indistinguishable from direct TLS.

Before installing Tuxee's CA in your client trust store, verify its SHA-256 fingerprint against the server. The server CA file also contains its private key: **never copy the complete `local-ca.pem` file to a client**. Extract only the certificate:

```sh
sudo openssl x509 -in /var/lib/tuxee/tls/local-ca.pem -noout -fingerprint -sha256
```

Browsers do not automatically trust this CA. An inherited/cached HSTS rule can prevent bypassing a certificate warning. Single-file service-worker download progress requires a trusted secure context; when unavailable, the browser's download manager provides progress and cancellation. ZIP downloads use server progress and cancellation over either HTTP or HTTPS.

## Languages and translations

Choose a language on the login screen. A fresh browser defaults to English; choices are sorted by code (`CS Čeština`, `EN English`). Changing language updates the form immediately and preserves entered credentials. A browser-managed `tuxee_language_<instance-id>` cookie remembers the choice for reloads, new tabs and later logins. The server uses it to include the initial dictionary in the page, without another language request. The cookie is a preference, not authentication.

The language and translation snapshot are fixed when you sign in. Changing the cookie or another tab's login preference does not change that session; sign out and select a language for the next login. Settings has no language control. Tuxee never rewrites application output or user-supplied names. Short localized desktop names apply to newly created workspaces; existing saved names remain unchanged and can be renamed from the tab menu.

New terminals pass the selected language to terminal/GUI applications through `LANGUAGE` (for example `cs:en`) and an installed UTF-8 `LC_MESSAGES`. `LANG` stays `C.UTF-8`; numeric/date formatting stays unchanged and `LC_ALL` is not set. Retained terminals keep their original environment across logout and later logins in another language. Your shell startup files may override these defaults.

This is best-effort application localization: apps need their own translations and may ignore these variables. If no matching system locale is installed, Tuxee keeps `LC_MESSAGES=C.UTF-8`; GNU apps may remain in English. The slim image includes only the C locale by default. Install the needed UTF-8 locale and application language packages through your normal Linux administration process, then restart Tuxee to refresh locale discovery. Tuxee does not install language packages or change host-wide settings.

The 43 built-in languages are Arabic (`ar`), Bulgarian (`bg`), Catalan (`ca`), Czech (`cs`), Danish (`da`), German (`de`), Greek (`el`), English (`en`), Spanish (`es`), Estonian (`et`), Persian (`fa`), Finnish (`fi`), Filipino (`fil`), French (`fr`), Hebrew (`he`), Hindi (`hi`), Croatian (`hr`), Hungarian (`hu`), Indonesian (`id`), Icelandic (`is`), Italian (`it`), Japanese (`ja`), Korean (`ko`), Lithuanian (`lt`), Latvian (`lv`), Malay (`ms`), Norwegian Bokmål (`nb`), Dutch (`nl`), Polish (`pl`), Brazilian Portuguese (`pt-BR`), European Portuguese (`pt-PT`), Romanian (`ro`), Russian (`ru`), Slovak (`sk`), Slovenian (`sl`), Serbian in Latin script (`sr-Latn`), Swedish (`sv`), Thai (`th`), Turkish (`tr`), Ukrainian (`uk`), Vietnamese (`vi`), Simplified Chinese (`zh-CN`), Traditional Chinese for Taiwan (`zh-TW`). All share `internal/i18n/locales/<code>.json`.

Arabic, Hebrew and Persian use a right-to-left interface. Terminals, code editors, commands and filesystem paths retain their original text order; changing language does not move saved workspace panels.

Administrators can create `/etc/tuxee/i18n/cs.json` to override individual texts:

```json
{
  "name": "Čeština",
  "texts": {
    "login.signIn": "Přihlásit se",
    "files.selectName": "Vybrat {name}"
  }
}
```

Use the same format and a valid language-code filename (for example `eo.json`) to add a language, with its native `name`. Files merge by key: system entries override built-ins; missing selected-language entries fall back to English. A new language can start with a partial catalog. There is no per-user translation folder. Keep all named variables from the English text; values are inserted as plain text. Missing keys or required variables show a compact diagnostic, for example `[!files.renameFailed name="report.txt"]`, without interrupting the UI.

Restart Tuxee to expose new files immediately on login. Catalogs also refresh on login or an explicit language selection, while existing sessions keep their original snapshot. Invalid files are logged and skipped. Use regular files, not symlinks; limits are 2 MiB per file, 16 MiB total and 256 directory entries. In Docker, persist custom files with a mount at `/etc/tuxee/i18n` if needed.

Developers must read [the i18n contract](../internal/i18n/AGENTS.md), translate each text in its UI context and update every built-in language. Use descriptive keys and named variables for changing limits/counts. Prefer Czech count-neutral forms such as `Soubory: {count}`; ordinary English singular/plural keys are supported. Keep short labels close to the English rendered length when natural; shorter is fine. Use compact desktop/space names and check two-digit tab names on narrow screens. Run `npm run check:i18n` after changes (also enforced by `npm run build`), review its advisory expansion warnings in `test-results/i18n-length-report.json`, and run `npm run test:i18n` after changes to localization behavior. Length warnings never fail the check; the report includes both texts, grapheme counts and the percentage increase, with named variables given equal weight. Preserve meaning and natural grammar when deciding whether to shorten a flagged text.

## Workspaces, files and terminals

GUI apps share text, PNG images and supported file references through the focused display. Use ⌘C/⌘X/⌘V on macOS or Ctrl+C/Ctrl+X/Ctrl+V; Shift variants retain the application's bindings. Apps with custom shortcuts still need their normal bindings. Copy waits for the application's new clipboard; selecting text alone and background displays leave the device clipboard unchanged. Native paste works through the browser's paste event, including ordinary HTTP when the browser exposes the data. Automatic copying requires browser clipboard access (normally HTTPS or localhost); if blocked, use **Copy to device**. Images also offer a download fallback. Text is limited to 256 KiB; PNG images to 16 MiB and 16 megapixels. Native formats other than text/PNG/local file lists are not bridged.

The visible view chooses the paste behavior: a terminal still uploads screenshots/files to ~/uploads and inserts shell-quoted paths; a GUI receives image data or native Linux file references. Generic image.png/clipboard-image.png clipboard PNGs are treated as images; named files are uploaded first. Browsers sometimes expose a copied image file as an anonymous image, so exact file-versus-image intent cannot always be recovered. File references copied from Tuxee on the same origin/account need no upload. GUI file copies can be pasted into Tuxee file browsers through device clipboard metadata; plain path text never triggers file operations. Files crossing the GUI bridge are copied, including cuts, because completion/deletion cannot be reliably acknowledged across applications. Existing file-browser-to-file-browser cuts still move normally. To save GUI files to your computer, use **Download files**; browser clipboard APIs cannot generally create Finder/Explorer native file entries.

Drop device files/folders over a GUI to upload and deliver a native Linux file drop, or drag Tuxee files there to reuse their paths. The receiving app decides whether to open/import them. If it rejects the drop, **Paste paths** explicitly inserts their Linux paths as text. Drops never type into the hidden terminal; switching away during an upload leaves uploaded files available without sending input. Dragging out of a GUI into the device file manager is not bridged. Linux Chromium with real GTK/Chromium apps is covered by npm run test:gui-clipboard; physical macOS/Safari/Finder needs device validation.

Settings → **Default directory** sets the starting folder for new terminals and file browsers, per Linux user. It defaults to `~`; absolute paths and `~/…` are supported. A workspace tab’s **Default directory** action overrides it for that workspace. Saving the global value (or clearing the field) removes the override. **Desktop default** in a single folder’s context menu, File actions menu or Properties uses that folder; with nothing selected, the current-folder menu and Properties use the current directory. The file browser’s Home button follows this preference. Terminal Reset and lost-session Restart use the current default; reconnecting and changing preferences keep existing shells and browsed paths. Refresh keeps the current folder, and **Open terminal here** still starts in the explicitly selected directory. Paths remain subject to Linux permissions; shell startup files can change cwd afterward. Properties places **Apply** beside Permissions.

Every workspace uses eight tiles: 4×2 on landscape and square screens, including ultrawides, or 2×4 in portrait. Cells adjust to the available width and height; each workspace holds at most eight components. Changing orientation transposes existing geometry, including saved custom layouts, without adding/removing components or restarting terminals. New landscape workspaces at least 1200×700 start two file browsers stacked in the left half and one full-height terminal in the right half. At least 1920×1000 also splits the right half into two terminals. Smaller/mobile/portrait workspaces start one browser and one terminal. Defaults apply only when creating a workspace. Legacy eight-column layouts convert automatically; panels beyond eight move to an additional workspace with their terminal sessions intact. Drag anywhere on a panel header to move the actual panel. Translucent grid cells and workspace highlights stay above windows; the dragged window remains 80% opaque until it is dropped or cancelled. Over another panel, the cursor selects the split edge or center swap; in empty grid space, hover a cell to fill it, a shared grid line to span two adjacent cells horizontally/vertically, or a crossing to span a 2×2 square. The window resizes to the highlight regardless of its previous size, so a large window fits a small hole. Overlapping drops shrink each affected neighbor to its largest remaining rectangle, preserving its one-cell minimum and leaving unaffected windows in place. If a neighbor cannot remain, jointly relocate only overlapping neighbors into available cells, shrinking when needed. Reject the drop only when those neighbors cannot fit. Grid targets spanning vacant and occupied cells work from either side of the boundary. Drops snap with an animation; invalid drops return to the original location. Add icons can also be dragged. Screen edges preview half/quarter layouts and reflow neighboring panels. Double-click a terminal title or the folder icon in a file-browser header to fill surrounding empty cells without moving or covering neighbors; if it cannot expand, it shrinks to one cell. Rearrange favors wide terminals and compact file lists, grouping files left and terminals right (files above terminals in portrait). Click to cycle Balanced → Terminals → Files → the saved custom layout; the icon rotates a quarter turn each time, with upright meaning custom. Clicking smoothly reveals the current mode label (Balanced, Terminals, Files or Custom). It stays open while hovered and collapses to the icon two seconds after the pointer leaves; hovering again cancels that countdown. Modes and the original geometry survive reload. Manual layout edits reset the cycle. Balanced keeps files slimmer and terminals wider, with reading room for both types, width caps of roughly 640px/1440px at grid-cell resolution, and spare side space centered. Terminals initially packs file browsers into single cells and maximizes terminal space; Files does the opposite, favoring full-height file lists. Each automatic layout then expands components into unused neighboring cells, with the priority type first, without shrinking components or moving/covering neighbors. Other components keep the normal width caps. These priority modes lift the chosen type’s pixel width cap, while file browsers remain at most two cells wide in every automatic layout. Spare space stays around the centered group; manual/custom layouts can still use wider panels. Modes can produce the same layout when both already use the available space well; components are never minimized just to make a mode look different. Resize from exposed outer panel edges or the small diagonal corner grips. Scrollbars on the right and bottom take priority inside every window; resize handles stay outside the content. Shared splitters take priority in the gaps between windows. Drag shared gaps or their junctions to resize adjoining panels together; focused dividers also accept arrow keys. The existing grid and one-cell minimums still apply, so two minimum-height rows cannot move their horizontal boundary. Release snaps smoothly to cells; Escape cancels. Click add to use an empty cell, then split the largest panel. The grid stays 4×2 or 2×4 at every screen size. Smaller viewports present one borderless component with icons, names and controls in top tabs, separated by faint pipes, while retaining components and orienting their saved grid. Desktop titlebars also show component icons. Rearrange is hidden on mobile. Excess tabs move into three-dot menus; workspace content never changes the page's responsive mode. The workspace plus follows the tabs. On desktop, component add/rearrange tools sit before the theme switch; on mobile, file/terminal add buttons follow the component tabs and stay visible beside their overflow control. Component overflow menus align icons/names left. Mobile component and workspace tabs have down-arrow menu buttons and long-press context menus, including overflow entries. Retained-terminal management lists only detached sessions, without IDs. Workspace creation stops at twelve; migrated legacy accounts may retain up to 24 to avoid losing panels. Terminal limits remain 32 sessions per user and 128 total. Panel changes preserve neighboring views; workspace switches slide adjacent full layouts left or right.

Closing a terminal panel or confirming workspace closure terminates its terminals in the background, including shells still starting. A failed termination does not block UI closure. Up to eight visited workspaces, including the active one, keep their views and terminal connections alive. Switching back reuses the existing terminal display and refreshes its size. Visiting a ninth disposes the first visited cached workspace; revisiting does not change that order. Its shell keeps running, and returning restores the existing snapshot. Reloads also use snapshot restoration. Hidden warm terminals remain attached; eviction and browser disconnection do not expire them. Unsaved file edits survive warm switches, with confirmation before eviction or closure. Logout checks edits in all cached workspaces and clears the entire cache. Logout revokes that browser login and its connections. Terminals have no idle timeout, so detached services can run indefinitely. Old timeout settings are ignored. **Retained terminals** lists sessions missing from all your workspaces, including sessions attached in another browser. Running unlisted sessions show a warning there and on the hamburger button; choose **Attach** or confirmed **Terminate**. Ended unlisted sessions remain available for cleanup without a warning. All account-menu warnings also appear on the hamburger button. Stopping/restarting Tuxee ends live terminals; saved layouts remain. Missing sessions show a centered **Terminal session lost** message and **Restart terminal** button on a background matching the UI theme. Restart creates a new shell; ordinary connection loss reconnects automatically, and a normally exited shell keeps its output.

If the backend becomes unreachable, a themed blur overlay shows **Connection lost, reconnecting...** with a loading indicator. It keeps the dashboard and drafts mounted until the backend returns a valid readiness response, which also reports whether your cookie is valid. The same check controls both recovery and login: after readiness confirms the signed-in session ended, the browser reloads the page to fetch the current frontend and show login. Initial and repeated anonymous checks do not reload the page. Failed or interrupted checks and stale replies preserve the dashboard. Startup failures show the same recovery screen, and monitoring continues on the login screen. Detection also works without terminals or resource monitoring. Recovery is automatic; credentials and failed file operations are not replayed.

**Settings → Shell command** selects the command used for new terminals, defaulting to `bash`. Enter an installed shell and its arguments, such as `zsh` or `/bin/bash --login`. This does not change your Linux account's login shell or install software. **Use Tuxee shell prompt** is on by default for Bash, Zsh and Fish, on native hosts and in containers. Switch it off to use your normal shell prompt. Both settings apply only to newly created terminals; existing and retained sessions stay unchanged.

The bundled prompt shows a bold green path, gold active environment, purple Git branch and default-color `❯`: `~/path in venv on main ❯ `. The full inline prompt, including spaces and `❯ `, stays on one line below 25 characters; at 25 or more it starts after a blank line and places `❯` on the second line. Color codes do not count. Git is optional; missing sections are omitted. `NO_COLOR` and `TERM=dumb` disable colors.

Tuxee loads these scripts only into its own terminal processes and never rewrites `.bashrc`, `.zshrc` or Fish configuration. Bash integration reads the system/login profiles through an application rcfile; Zsh and Fish use their startup hooks. Startup-disabling flags may bypass integration. Other shells use their own prompt. Updating and restarting Tuxee supplies the current prompt to new sessions without a separate prompt installation.

Only one attachment controls input/resize. Other browser views can use Take control. **Settings → Terminal background** sets your terminal background, defaulting to `rgb(26 32 44)` (`#1a202c`) in both light and dark themes. **Save** applies it to open and detached terminals without restarting their processes; new terminals use the saved color too. **Reset**, then **Save**, restores the default. Closing Settings without saving leaves the color unchanged. Programs can still set their own colors, preserved through reconnects, resizing and theme changes; changing the saved background replaces their current background while retaining other palette colors.

Terminal login shells start with `umask 022`: ordinary new files are `0644` and directories `0755`, subject to application modes and filesystem ACLs. System/user startup files can override this default. Commands and GUI apps launched from the shell inherit its mask; Tuxee's own state and private helpers retain `077`. This applies to new terminals after updating/restarting Tuxee. Existing shells can use `umask 022`; existing files keep their permissions and need targeted corrections when appropriate.

On touch screens, drag terminal output vertically to scroll history. When an application owns mouse input, the gesture sends its wheel reports; alternate-screen applications without mouse reporting receive arrow keys. On desktop, select terminal text with the mouse and copy it using the browser’s normal copy action. xterm 6.0 lacks native mobile selection handles and has an [upstream touch-scrolling regression](https://github.com/xtermjs/xterm.js/issues/5489); Tuxee handles gestures in its shared terminal browser adapter.

Mobile add-file/add-terminal controls stay at the right edge of the component tab bar, alongside tab overflow. Workspace closure is available from the workspace tab's context menu, rather than the account menu. Login fields use 16px text to avoid iOS focus zoom, and the logo/spacing shrink with keyboard space. Intentional pinch zoom remains available. Chromium touch events, clipboard checks and visual-viewport keyboard simulation are automated; physical iOS keyboard animation and native selection handles still require device verification.

File drag between browsers defaults to **move**; Ctrl/⌘/Option changes it to **copy**. Internal drags use pointer handling to avoid native macOS modifier filtering; uploads from the desktop still use native file drops. Inside the same browser, dragging only acts when copying; moves are silent no-ops. Group feedback includes all selected files/folders. Buttons provide the same operations without dragging. Checkboxes before file icons toggle selection without opening files. Drag up/down in that column to select or deselect crossed rows; revisiting a row keeps the same choice, and Escape/cancellation restores the starting selection. The header checkbox selects/deselects the visible listing and shows mixed selection. Scrolling elsewhere in the list remains native. Touch-hold a file row for its menu without selecting label text. Right-click opens a menu at the click; the actions button anchors it to that button. Typing filters the loaded list and shows the query in the footer. Up/Down moves focus, Shift+Up/Down extends/shrinks selection, Right enters folders, Left exits, and Space toggles selection. Alt, ContextMenu, or Shift+F10 opens the keyboard menu; Escape closes it without deselecting. Enter opens, F2 renames, Delete confirms, and Ctrl/⌘+A selects all. Properties supports multiple selected files and folders. Folder selections automatically calculate their contents, updating the total every 500 ms. Stop preserves the partial total and reveals Calculate to start again; closing Properties or disconnecting stops the scan. The Stop button follows the calculating status. Sizes use a space and single-letter units (`1.5 K`, `12 M`), with one decimal below 10; hover over the number for exact bytes. A `~` prefix marks a running, stopped or incomplete total. Scans count apparent file sizes (hard links per entry) and symlinks themselves, without following directory links or adding directory inode sizes. Unreadable entries and traversal limits are reported as skipped. Scans run at low priority, yield between batches and stop after five minutes; reopen Properties to retry an interrupted calculation. With nothing selected, the footer info button opens properties of the current folder. Right-click empty folder space and choose Properties to inspect that folder too. Explicit destination collisions fail without overwriting; copies into the same directory receive ` (copy)` or numbered sibling names. Uploads and copies stage their output and clean up on cancellation. Multi-item operations may complete some items before a later item fails; completed items are retained. Single files download directly. Selecting a folder or multiple items downloads one ZIP, streamed while it is compressed without a temporary archive. The local progress bar shows the growing compressed ZIP size and a Cancel button that stops compression and transfer. Its final size is unknown until completion, so progress is indeterminate. ZIP progress and cancellation also work over plain HTTP. Empty folders and symlinks are preserved; unreadable or special files fail the download instead of silently producing an incomplete archive. Folder icons in the file list are filled; file icons remain outlines. Compress/extract actions use installed tar/compressors and 7zz/7z, with ZIP/7z passwords when available. Extraction creates a new folder and never overwrites an existing destination. Use current archive utilities.

Select files and use **Cut**, **Copy** or **Paste** in the toolbar/menu, or Ctrl/⌘+X, C and V with the file list focused. Paste uses the current folder; copying into the source folder creates numbered duplicates. The device clipboard contains shell-quoted paths usable as terminal arguments plus separate Tuxee metadata. Ordinary path text copied from a terminal never triggers a file operation. Copy works across panels, workspaces and tabs on the same origin/account and remains usable after reload. Cut dims the pending files and moves them only on Paste; completed items cannot be moved again, while failed/unprocessed items remain pending. A cut belongs to its original browser page and ends on reload, logout, another copy/cut or Escape in the file list. Cancelled/interrupted moves with an uncertain outcome must be checked and cut again. Existing destinations are never overwritten. Copy to… and Move to… remain in item menus. Keyboard clipboard operations also work on ordinary HTTP; when a browser cannot read the clipboard for the Paste button, use the indicated keyboard shortcut. Clipboard managers that strip Tuxee metadata leave the quoted text usable, but file-browser paste does nothing.

Outside the checkbox column, click or tap a file row to select it; double-click or double-tap to enter a folder or open the bundled CodeMirror 6 editor or native image/PDF/media viewer. Drag from the name/icon to move or copy files; drag from the rest of the row or list margins to draw a selection rectangle. The rectangle selects rows it overlaps anywhere across their width, including the size/date columns. Syntax is selected by extension and can be changed; extensionless dotfiles default to shell. Binary/non-UTF-8 content is rejected. Text opens sequentially in pages of at most 1 MiB and 10,000 budgeted rows (each 1,000 Unicode characters counts as another row). Line wrap fits text to the editor width without changing file bytes; it defaults on, and its checkbox saves your choice for future files and logins. Turn it off for horizontal scrolling. Open files show their full path in the editable panel header, including during media navigation. Paste a full file path there to open it directly without browsing its parent first. The editor toolbar starts with Back, a pipe, Undo/Redo, Search and replace, Download and Save; Undo/Redo are disabled when their history is empty. Back returns to the open file’s parent folder. Both editor and media toolbars stay on one row and move excess controls into the three-dot menu. The editor footer has Line wrap, a pipe and syntax selection on the left; on the right, multi-page files have Page up/number/down and a pipe before the total size. Sizes use B/K/M/G, reflect pending edits, and show exact bytes on hover. Changing pages asks to save pending edits; cancelling or a failed save keeps the current draft. Previous/next file controls and Left/Right navigation remain for media previews. Saves validate the file version and original page hash, preserve every byte outside that page, and retain untouched line endings, ownership, ordinary permissions and extended attributes. The complete prefix, edited page and suffix are streamed into a temporary file before atomic replacement: saving requires disk space for the complete result and parent-directory write access, and changes the inode, leaving other hard links unchanged. Advisory locks cannot exclude other programs that ignore them. Unsaved changes require confirmation before closing. PDF rendering and media codec support depend on the browser. Archive passwords are transient and passed to tools through stdin.

Media previews start with a back arrow returning to the open file’s parent folder, followed by chevrons around the current/total count, image zoom controls, then Copy and Download, with pipes between groups. Image copy appears only when supported by the browser and copies the original-resolution image as PNG; clipboard permission may be required. Video, audio and PDF previews omit image zoom/copy. Images start fitted to the panel. Previous/Next and Left/Right loop through all images, PDFs, videos and audio files in the current visible file list, wrapping at either end. The counter counts that same media list regardless of which file you open first; text and other files are skipped. Use zoom buttons, pinch or Ctrl-wheel to zoom; the percentage button returns to 100%, and Fit resets the view. Drag to pan or scroll in both directions with a touchpad, including diagonal movement. Double-click toggles fit/zoom. With the image focused, `+`/`-` zoom, `0` fits and `1` selects actual size. Zoom is capped at 1600%; changing images resets the view.

Drop OS files or folders onto a file browser to upload into its current directory, or onto a connected terminal to upload into your `~/uploads` and insert quoted paths without pressing Enter. Folder hierarchy and empty folders are preserved. Each batch has one progress bar with file count and total bytes. Repeated names receive numbered suffixes such as `photo (1).png` or `folder (1)`; existing data is never overwritten. Drops outside panels are ignored. Paste screenshots or files exposed by the browser with normal Paste (Ctrl/⌘+V in file lists, ⌘+V on macOS terminals or Shift+Insert on Linux terminals); screenshots use `clipboard-image.png` and numbered variants. Ordinary text paste and input fields stay unchanged. File-manager clipboard support depends on the browser/OS; clipboard text containing local paths is never treated as file access. Switching to another warm workspace keeps uploads running. Cancelling, closing the component, evicting its workspace or logging out stops pending uploads; files and folders already created remain. Terminal paths are pasted only when the whole batch succeeds and the terminal still accepts input.

Delete or the file menu's Delete action normally moves the selection to the Linux account's trash. The confirmation counts files and folders; select **Delete permanently instead** to bypass trash, or use Shift+Delete to preselect that option. Trash failures leave files in place and never silently switch to permanent deletion. The trash icon beside Home opens the combined home/mounted-drive bin. Select entries and press **Restore**, or use **Empty bin** with confirmation. Restore refuses to overwrite existing files and needs the original parent directory to exist. Restore items before opening or editing them. Download, Cut and Copy are disabled without a selection.

Tuxee reuses FreeDesktop `files/` and `.trashinfo` records in the user's `~/.local/share/Trash`, plus `.Trash/$uid` or `.Trash-$uid` on mounted filesystems. File workers use a clean account environment, so a different desktop session's custom `XDG_DATA_HOME` is not imported. Files remain on their original filesystem; if a private trash directory cannot be used there, trashing fails explicitly. Trash persists across Tuxee restarts, consumes disk space and has no automatic expiry. Emptying the bin also removes items placed there by compatible desktop applications.

File browsers have no embedded command terminal. Desktop file-browser headers contain a folder icon, an editable left-aligned path and Close, saving a separate address row. Click and release the path to edit it, or focus it with the keyboard; dragging from it moves the panel. Enter opens a directory or file path and Escape cancels path editing. The path looks like the header until focused. Mobile keeps the path on its own row and uses the open filename or last folder name in its component tab (Files at `/`). File-browser renaming is removed. On both layouts, the action row starts Up, Home and Trash bin in a stronger color, a pipe, then Refresh and the other actions; buttons that do not fit move into the three-dot menu. Rename terminals with the pencil in the footer immediately before Reconnect, or with Rename in the component menu. Reset in the rename dialog restores **Terminal**. Names survive reattachment and appear in Retained terminals; application titles never change them. Close remains in the desktop header and mobile tab menu. On mobile, Take control is also available in the terminal-tab menu when needed. Notifications and progress appear inside their originating component; global actions use viewport notifications. Modal content scrolls below a fixed header with an always-reachable Close button. Confirmation dialogs focus the confirming button so Enter confirms. In terminals, Ctrl+C sends an interrupt; Ctrl+Shift+C copies selected text on Linux/Windows, and Command+C uses native copying on Macs. The GUI clipboard bridge forwards shortcuts even while copying and stays silent when no clipboard change occurs, including interrupts in a nested terminal. Use normal keyboard/OS clipboard controls; dropping files from a file browser inserts their shell-quoted paths without pressing Enter. The username/menu button opens directly below itself.

Workspace tabs on desktop/mobile have a down-chevron for **Activate**, **Rename** and **Close**. Mobile component chevrons offer activation, additions, moving and closing, plus Rename for terminals. Drag workspace labels to reorder them; adjacent tabs slide into place and the order is saved. Overflow entries can be reordered within their list. Alt+Left/Right also moves a focused workspace tab; Escape cancels a drag. Reordering keeps the current workspace and its terminals running. Right-click workspace or component tabs for the same menu; on mobile, hold the tab briefly. The same menu is available with the ContextMenu key or Shift+F10, including overflow entries. A normal tap switches tabs; moving or scrolling cancels a hold. Workspace closure still asks for confirmation.

The header defaults to **CPU**, **RAM**, **DISK** (the root filesystem) and **NET** widgets after the add/layout buttons, separated by pipes. NET sums active interfaces (operstate up/unknown), including loopback and virtual interfaces; traffic crossing multiple interfaces is counted at each. Configuration labels it “Sum of all active interfaces”. Existing saved choices stay unchanged, and individual interfaces remain selectable. Click the widgets for larger copies in the Resource monitor cards, with extra details below, then the cog to choose CPU/RAM/swap, disks, interfaces and a 2/5/10-second refresh interval.

Readings use large numbers with smaller muted units: `%` or B/K/M/G/T/P/E/Z. All size displays use single-letter units, including details, tooltips, process rows, file properties and transfer progress. RAM/swap, process memory and file sizes use binary scaling; disk and network values use decimal scaling consistently in headlines, details and tooltips. File-size tooltips show exact bytes; network rates append /s. Large sizes scale through T/P/E/Z instead of stopping at G. CPU and RAM gauges are purple; disks are green. RAM stacks estimated non-reclaimable usage at the bottom in purple, reclaimable cache above it in green, and free memory as the empty top. Its headline shows non-reclaimable usage; details include used/total, cache and available amounts. Network shows download/upload rates with purple/green arrows, without ratio gauges. Disk values describe each mounted local filesystem, including shared backing storage in containers. Container CPU/memory use cgroup v1/v2 counters and visible limits. Remote/pseudo filesystems are excluded.

The desktop/mobile user menu has a plain **Resource monitor** action for opening the modal. Its **Display resource monitor widget** switch hides the header widgets and their separator without resetting your choices. While display is off, polling runs only while the modal is open; opening the user menu does not restart it. The menu action remains available for a live quick look or to turn display back on. Preferences belong to the signed-in user. Monitoring pauses in hidden tabs.

The Resource monitor's **Processes** tab shows an on-demand process tree. Select a process to include its eligible descendants, then use **Kill** to choose SIGTERM or Force kill. **Allow killing core**, beside Refresh, enables selection of PID 1, Tuxee and its startup ancestors where your Linux account has signal permission. It starts unchecked and resets when the view closes. Killing these processes can disconnect the app or stop the container; Docker's restart policy determines whether a stopped container restarts. The list refreshes once 500 ms after a kill attempt while the view remains open; processes still shutting down may need another manual Refresh.

Process **RAM (own)** uses anonymous/shared proportional memory (`Pss_Anon + Pss_Shmem` from Linux's [smaps_rollup counters](https://docs.kernel.org/filesystems/proc.html)), so parent totals apportion shared pages instead of repeatedly counting them. RAM tooltips show file-backed PSS separately, including mapped executables, libraries and data files. When Linux denies proportional reads or lacks those counters, use `RssAnon + RssShmem`: own RAM gains `~`, and tooltips identify RSS estimates in parent/group and selected-process totals. These estimates may overcount shared pages. Unavailable readings show a dash. Reads run only on process refresh; the widget keeps its inexpensive non-reclaimable-memory calculation. Totals need not match: kernel memory, unmapped tmpfs and dirty/locked file pages cannot all be assigned to these process numbers, and cgroups account for shared pages differently.

Container CPU usage is the increase in CPU time divided by elapsed time and effective core capacity, multiplied by 100. One fully busy core out of eight available cores is 12.5%; other containers and host processes are excluded. Native installations use aggregate `/proc/stat` busy time, excluding idle and I/O wait. htop's CPU bars read `/proc/stat`, so they can include host or VM activity outside the container; refresh intervals can also differ. Tuxee defaults to a two-second refresh and shows one decimal below 10%, suppresses values rounding to zero, and rounds values reaching 10% or more to whole percentages. Process rows and selection summaries use the same rounding, while preserving per-core CPU values above 100%.

Click the workspace logo or choose **About** in the user menu for the Tuxee version, operating system, kernel, architecture, server name and signed-in account details.
About links to GitHub and shows a compact update row directly below the version:
status, local check time and **Check now**. Available updates highlight that row
with a notification icon and show the update command, with matching alerts on
About and the hamburger button. The server checks at startup and daily at
00:01 in its local timezone; visible browsers refresh the cached result each minute.
Installing an update preserves running sessions; restarting ends them.

## Docker

```sh
ROOT_PASSWORD='your-password' docker compose up -d
docker compose logs -f tuxee
```

Compose pulls the published amd64/arm64 image and starts it with its built-in defaults. No host configuration file is needed. To test local source instead,
run `docker build -t agent0ai/tuxee:latest .`, then
`ROOT_PASSWORD='your-password' docker compose up -d --pull never`.
See [Docker updates](releases.md#docker-updates) for binary and image updates.

Open `https://SERVER/` and sign in as **root** with `ROOT_PASSWORD`. If omitted, it defaults to **toor**. With `docker run`, pass `-e ROOT_PASSWORD='your-password'`. The entrypoint sets it on the first start of each new container, before Tuxee or init scripts run. Later restarts do not reset passwords changed with `passwd`; recreating the container initializes its new account database from `ROOT_PASSWORD` again. The completion marker stays in `/opt/tuxee/.root-password-initialized`, in the container's writable layer alongside the account database lifecycle, not a persistent volume. Empty passwords and line breaks are rejected; a failed update prevents startup and can retry on the next start. The password is sent to `chpasswd` through stdin and `ROOT_PASSWORD` is removed from the environment inherited by Tuxee and init scripts.

The image creates no tuxee user and persists `/root` for user files/settings. Run commands directly as root, omitting `sudo`. The image and upgrade setup do not install sudo or a replacement wrapper; install the real package yourself if needed. Shell and prompt preferences are available in Settings, as described above. Binary upgrades remove the obsolete Tuxee system prompt profiles; user startup files remain untouched.

Container Bash binds Shift+Enter to insert a newline without running the command; Enter runs the completed input. The default lives in `/etc/bash.bashrc`, so reused home volumes receive it too. Container upgrade setup adds it for new shells after the upgraded server starts. Applications such as Codex still receive the original Shift+Enter sequence. Native Bash users can add `bind '"\e[13;2u": "\C-v\C-j"'` to their own `~/.bashrc`; this uses Bash's default Ctrl+V quoted-insert binding.

The final image uses Debian 13 Trixie slim with a stripped Go executable and runtime dependencies. The Go builder stays on Debian 12 Bookworm to preserve compatibility for the exported native CGO/PAM binary. Node/npm stay in the frontend build stage; Go, compiler tools, frontend node_modules and build caches are excluded. Apt lists, installation logs and generated package-database backups are removed in the installation layer. Debian slim already excludes most documentation and translations while retaining licenses. Keep active apt/dpkg metadata so users can install software normally. Docker may retain builder caches on the build host; those are separate from the tagged runtime image. Deleting files inherited from a base layer does not remove their bytes from that layer.

A Bash loop restarts Tuxee one second after any exit. On container shutdown it stops restarting, signals Tuxee and the init runner, and waits for them; Compose allows 30 seconds before forcing termination. [Tini](https://github.com/krallin/tini) runs as PID 1 to forward signals and reap orphaned processes. No privileged mode or host setup is required.

Docker launches `/init/*.sh` independently in parallel on every container start alongside Tuxee. Scripts may run indefinitely; one blocking or crashing does not stop Tuxee or the others. There is no execution order guarantee. Scripts run as container root through Bash; executable permission is unnecessary. Failures are logged, and finished scripts are not automatically restarted. Use a restart loop when a program should restart after exiting. Restarting Tuxee alone does not rerun these hooks. The runner waits for active scripts and terminates their process groups on shutdown. Instructions and examples are available in [the startup-script README](../docker/init/README.md), installed at `/init/README.md`. Compose persists this folder in `tuxee-init`; replace the mount with `./my-init:/init` to manage scripts from the host. Native installations do not run init scripts. Existing scripts that use Node/npm or PM2 must install those dependencies or launch services directly.

Compose publishes HTTP 80 and HTTPS 443 and keeps persistent data in three named volumes:

| Container path | Data |
| --- | --- |
| `/var/lib/tuxee` | Server state and certificates |
| `/root` | User files and settings, including layouts |
| `/init` | Startup scripts |

Separate Compose projects get separate volumes automatically. No configuration volume or per-instance JSON file is needed. Account/password changes survive container restarts; recreating a container initializes its account database again. Container mode manages the container, not the host.

To use different host ports, change only the published ports:

```sh
docker run -p 8080:80 -p 8443:443 agent0ai/tuxee
```

The equivalent Compose mappings are `"8080:80"` and `"8443:443"`. Changing the
internal listeners is optional; see [listening ports](#listening-ports).
Public certificate issuance still requires public TCP 443 to reach Tuxee's TLS
listener. With a TLS-terminating proxy, the proxy manages certificates instead.

## Reverse proxies

Start the image as supplied and forward your domain to **container port 80**.
Traefik, Caddy and other TLS-terminating proxies can serve the public HTTPS URL
without any Tuxee configuration. Forward HTTP and WebSocket connections and
preserve the public Host header (Traefik's default). Only the proxy needs the
domain and certificate configuration. Tuxee's unused HTTPS listener can stay
at its default; there is no need to disable ACME, set `origin`, or mount a config.
Keep the backend on the proxy's private network.

Browser same-origin checks work across TLS termination. Secure login cookies
follow the browser's HTTPS Origin or the usual `X-Forwarded-Proto: https` header;
forwarded host headers never authorize a request. Session authentication, CSRF
tokens and WebSocket origin checks remain enforced.

## Optional configuration

Most deployments need no configuration file. For custom settings,
`--config /absolute/file.json` loads JSON; [the example](../docker/tuxee.example.json)
shows the defaults. Flags override environment, which overrides JSON and defaults.
All supplied port environment values must be valid, even when a flag overrides them.
Existing `origin` overrides remain supported, but reverse proxies do not require one.
The image contains `/etc/tuxee/config.json`; edit or replace it only when changing
advanced settings. Its default command and healthcheck read the same file and
environment. Custom command-line listener options require matching healthcheck options.

## Verification

```sh
npm run test:layout
npm run test:proxy
TUXEE_SYSTEM_TEST=1 GOMAXPROCS=2 go test -p 2 -race ./internal/... ./cmd/... ./tests
go vet ./...
npm run test:browser
npm run test:uploads
npm run test:tabs
npm run test:mobile
npm run test:mobile-files
npm run test:features
npm run test:monitoring
npm run test:installer
npm run test:updates
bash tests/shell-prompt.bash
node tests/shell-settings.mjs
node tests/retained.mjs
node tests/restart.mjs
npm run test:docker-init
```

`TUXEE_SYSTEM_TEST=1 go test ./tests -run 'TestIndependentListeners|TestPortStartupFailures'` checks custom/default ports, zero disabling with occupied default ports, exact child TCP sockets, failure cleanup, image health probes, locally trusted TLS, PAM sessions, readiness and WebSocket attachment. It uses the dedicated marked account `tuxee-poc-ports`; default-port startup skips if another service already owns 80 or 443. It does not change running services.

The system integration test launches the built binary on isolated ports and checks real PAM, trusted local-CA HTTPS, browser attachment and reconnection, controller transfer, logout, retention despite legacy timeout values and explicit termination. Browser tests expect the local prototype URL above by default; override `TUXEE_TEST_URL` if needed. They use Chromium at `/usr/bin/chromium`, real accounts, filesystem operations and PTYs. Dedicated browser accounts are `tuxee-poc-a` and `tuxee-poc-b`; the isolated system test uses `tuxee-poc-system`. Tests refuse unrelated accounts, generate passwords only in memory and reset their dedicated fixtures. Set usable passwords afterward with `sudo passwd tuxee-poc-a` and `sudo passwd tuxee-poc-b`.

Browser tests explicitly bypass certificate validation for the isolated local test instance. Separate Go tests verify the local CA and TLS switching without that bypass. The system test also verifies default ACME enrollment on a nonstandard port against a local failing CA before sending any HTTP request. No production ACME requests are made by these tests.

Local validation passed: backend race tests and vet; real PAM/UID/group permissions; retained PTY/WebSocket takeover and reconnection; alternate-screen Unicode and application colors after reload/resize; desktop, portrait, ultrawide and mobile browser flows; file copy/move/chmod and streaming upload/download progress/cancellation; keyboard file navigation, multi-file permissions and tab overflow; workspace/theme persistence; and a 64 MiB transfer memory bound. Feature checks also cover real grouped/same-browser Control/Command/Option drag copies, edge reflow, free-space expansion/rearrange, bundled CodeMirror syntax/save/discard, CRLF and stale-save protection, image/PDF/audio previews, and password-protected archives. Chromium reported no unexpected console errors or external asset requests. Systemd accepted the generated unit through `systemd-analyze verify`; install/reinstall safety and clear refusal without a running manager were checked. Explicit loopback HTTP also passed a live launch/health/shutdown check.

This environment has no running systemd manager. Unit generation and registration safety are testable here; actual boot enablement/lifecycle needs a suitable host. Docker runtime smoke checks use a separate sandbox daemon; full image builds and registry publication still require CI. Public Internet ACME reachability has not been exercised here.

The Docker init check uses temporary folders and real Bash processes without touching the host's `/init`. When run as root, it also checks first-run password initialization through the real `chpasswd --root` against disposable account files, preserving the host's accounts. With Tini on PATH, it checks the production entrypoint's parallel framework/init startup, restart after clean exits and crashes, and shutdown with fixture services; otherwise that portion reports a skip.

## Reuse and remaining limits

CodeMirror 6 and its syntax modes are vendored from `the8020/uui`. The canonical xterm engine and full snapshot restoration reuse `the8020/dev-core`; session lifecycle contracts adapt `the8020/kernel`; certificate eligibility and fallback policies adapt `the8020/https`. Go's lego library performs ACME. GridStack supplies grid placement/resizing. The distributed database/sandbox runtime is intentionally excluded. Attribution is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

PAM authentication/account checks are implemented; full PAM login-session modules, systemd-logind integration, and persistent processes across service restarts are not implemented. The root server is a privileged management surface and still needs a production security review before public deployment.
