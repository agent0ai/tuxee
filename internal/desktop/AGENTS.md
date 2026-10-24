Parent DOX: [internal](../AGENTS.md).

# Purpose

Lazy X11 displays owned by retained terminals.

# Ownership

Prepare private display endpoints and credentials, start/stop the runtime, proxy local X connections, and report, activate and close native windows. Terminal owns endpoint lifetime and browser events; server owns admission and VNC transport. The sibling audio package owns user audio independently of displays.

# Local Contracts

- Prepare allocates credentials and filesystem/abstract Unix listeners only. Start one `tuxee-Xvnc`, Matchbox and session D-Bus on the first connection; concurrent clients share startup. Native installations without `tuxee-Xvnc` retain ordinary terminals.
- Give each terminal a stable DISPLAY, XAUTHORITY, XDG_RUNTIME_DIR and D-Bus address before its shell starts. Check SO_PEERCRED before allocating the runtime. Keep files owner-only, drop UID/GID/groups and use independent random X cookies and VNC passwords. No TCP listeners.
- Stop the runtime two seconds after the last managed window disappears; cancel that grace period when a window appears. A new X connection with no windows gets 30 seconds to create its first window. Windowless/background X clients are disconnected at reclamation. Keep the public endpoint/cookie and shell environment for lazy relaunch; remove transient runtime sockets/FIFO/password file, and clear XGB/process/window references. Serialize start/connect/stop and invalidate stale idle callbacks and window watchers. Terminal exit/closure and server shutdown close sockets, kill the runtime group and delete credentials. Serialize group signals with reaping; never signal a reused PID. Logout/detach preserves displays that still have windows.
- Use Matchbox's constrained dialog sizing. Disable MIT-SHM because the X proxy forwards bytes, not ancillary file descriptors; GLX/DRI are absent from the minimal build.
- Keep TigerVNC clipboard exchange enabled, with `SendPrimary=0` and `SetPrimary=0`. Selecting text must not export PRIMARY or race an incoming paste. The native clipboard bridge shares the existing XGB connection; no new process or runtime package.
- clipboard.go owns XFixes CLIPBOARD ownership notifications and bounded TARGETS/TIMESTAMP/MULTIPLE/INCR selection transfers. Keep one incoming clipboard payload per active display, 16 MiB PNG/16 megapixels, 256 KiB text/path bytes, at most 1,000 local absolute file paths, 16 viewers and 16 outgoing incremental transfers. Use versioned reads with ten-second cancellation and fresh requestor windows; release transfers/subscriptions when the display ends. Reject remote file URIs and malformed paths; never read file contents in the server identity. Publish file references as copy, including GNOME and URI-list formats; never implement DELETE or propagate file-cut deletion.
- drop.go owns bounded XDND Copy negotiation at a validated window/coordinate, including proxy validation and rejection/timeout feedback. Preserve source files and let the target app decide open/import behavior. Serve drop selections while negotiating; no polling, shell commands or automatic path-paste fallback.
- Watch EWMH property events through XGB; no polling process. Bound window lists, names and icon properties; convert icons to 32-pixel PNGs. Activate/close only a window in this display's current list. Close sends EWMH `_NET_CLOSE_WINDOW` through Matchbox, preserving the application's normal save/cancel prompts.
- No desktop environment, command launcher, microphone forwarding, GPU support, automatic crash restart or service-restart survival; a new client connection may retry startup. Displays separate windows, not filesystem/process permissions.

# Work Guidance

Use existing terminal lifetime, HTTP authentication and XGB dependency. Keep the image small: clipboard/drop support must not add runtime libraries, packages or helper processes. Keep ordinary terminals free of GUI processes and polling.

# Verification

`TUXEE_SYSTEM_TEST=1 go test -race ./internal/desktop ./internal/terminal ./internal/server` checks lazy startup, UID isolation, lifecycle, repeated idle release/relaunch and stale-timer cancellation, icon bounds and admission. `TestIdleDisplayMemory` measures live Go allocations for 32 unused displays. Clipboard tests cover real xclip incremental PNG send/receive, file-URI round trips, stale versions, malformed/oversized data and display-close cleanup. `npm run test:gui-clipboard` checks native GTK/Chromium clipboard/drop behavior. `npm run test:gui` checks real terminal/GTK/xterm inputs, windows, dialogs, persistence and screenshots.

# Child DOX Index

No children.
