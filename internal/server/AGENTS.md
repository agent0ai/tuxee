Parent DOX: [internal](../AGENTS.md).

# Purpose

Authenticated HTTP API, application sessions, per-user settings, and WebSocket terminal views.

# Ownership

Own HTTP routing and session revocation. Delegate filesystem syscalls to files, account checks to identity, process discovery/signals to processes, and all terminal lifetime/control to terminal.

# Local Contracts

Cookies contain random revocable tokens; login passwords never leave the isolated authentication path. Archive passwords are transient filesystem-worker input. Mutations require same-origin admission and a session CSRF token. Logout cancels all requests/WebSockets associated with that login, but never closes retained PTYs. Every terminal operation verifies its Linux owner. User settings validate whole-layout bounds and overlap before an atomic user-owned save. File transfers stream under the user's credentials.

Close marks the service unavailable before revoking logins. While shutting down, return no-store JSON 503 responses, including health, assets and login; never report revoked shutdown sessions as expired credentials or admit a login after Close. Healthy `/health` is also uncached. `GET /api/connection` is the browser readiness contract: return no-store JSON 200 with `authenticated: true/false` based on the same cookie/session admission as other APIs. Missing, invalid and expired cookies report false only while the service is available; shutdown always reports 503, never a ready anonymous session. Keep `/health` for container liveness.

Terminal lifetime has no timeout setting. Ignore legacy `idleHours` when loading settings and accept/drop it on save, so existing clients and saved layouts remain usable. Never include it in returned or newly persisted settings.

`POST /api/upload?path=…&unique=true` streams a size-declared file through the credential-dropped worker and returns its actual `path`. The worker owns collision naming; the HTTP layer must not pre-check or retry destinations. Omitted/false unique keeps explicit no-overwrite behavior for New file. Directory upload preparation uses the existing files API's mkdir with unique or parents flags.

`POST /api/download-archive` registers a sibling selection and returns a random session-bound token/name. `GET /api/download?archive=token` claims it once and streams the worker's ZIP immediately without Content-Length or a temporary archive. `GET /api/download-archive?token=token` reports compressed bytes sent, completion and errors; DELETE cancels/removes it. Require the same login for every operation and CSRF for registration/cancellation. Bound pending records to 128 and active workers through the shared file slots; expire unused/completed records after one minute and stop active streams after 30 minutes. Logout/disconnection/cancellation stops the worker. Failed ZIP streams must abort the HTTP response instead of reporting a successful partial archive.

Multiple selected items use the cleaned parent directory's basename plus `.zip`, or `sys-root.zip` for `/`. A single selected folder retains its own name plus `.zip`. Registration, progress UI and Content-Disposition share this server-owned name.

Optional workspace `layout` stores auto mode 1/2/3 and `custom` geometry keyed by panel ID. Validate both current and saved positions with the same bounds/overlap check; the custom snapshot must contain exactly the current panel IDs, without duplicates. It stores no paths or terminal identities. Absent layout means custom and remains compatible with older settings.

Optional file-panel `name` is a display label, limited to 80 bytes with no NUL. Accept absent/empty labels for older settings; reject nonempty labels on terminal panels because terminal sessions own their names. Preserve the field through the existing user-owned settings load/save.

ServeHTTPS wraps the existing Go TLS listener to return an empty 308 redirect for plaintext HTTP on that same port. Preserve the request host, explicit port, escaped path and query; do not trust forwarded headers. Never pass plaintext requests to application handlers. Use the existing TLS handshake deadlines and bounded header parsing; malformed requests return 400. Keep the wrapper small: no separate protocol dispatcher or listener lifecycle. Explicit --http remains plain HTTP.

The bundled index inline script requires the build-generated SHA-256 CSP hash. Replace its metadata origin marker with the HTML-escaped existing origin(r), honoring configured external origin without trusting forwarded headers. Negotiate gzip after substitution; use one gzip stream so browsers receive the complete page. Open Graph/social URLs are absolute; public favicon/preview files contain only static branding, never authenticated data. Terminal transport waits for a render acknowledgement before sending the next display event; input acknowledgement means bytes were consumed by the PTY writer. Terminal identity is separate from cookies and views.

Authenticated `GET /api/system` supplies the About modal with the executable's version, OS release, kernel, architecture, hostname and the current session's username, UID, home and shell. Read system metadata within the running environment, including containers; never substitute the server process account for the signed-in user. The CLI passes the same version used by `tuxee version`.

Authenticated `GET /api/metrics` returns the shared monitor snapshot with no-store caching headers. It accepts no user paths or interface queries. Optional per-user `monitoring` settings select CPU/RAM/swap, up to eight absolute mount paths and eight network selections (Linux interface names or the reserved `/all` aggregate), and a 2/5/10-second refresh interval. The optional boolean `hidden` hides persistent gauges; absent/false keeps them shown and does not restrict on-demand metrics access. Missing preferences retain frontend defaults; validate names, duplicates, counts and interval before the existing user-owned atomic save.

Authenticated `GET /api/processes?sort=ram|cpu` obtains a fresh credential-dropped snapshot, returning at most 1,000 process/group/zombie rows and a random session-bound snapshot ID. Keep one immutable full snapshot per login, replacing it on refresh/sort; other views using the previous ID must refresh. Release it on matching CSRF-protected DELETE, logout or after 30 minutes. POST accepts only that snapshot ID, displayed selection IDs and signal 15/9; resolve grouped descendants from the saved snapshot and delegate identity/permission checks and signals to processes. No arbitrary client PID/command execution and no discovery of new kill targets. Bound reads and kills independently to two concurrent helpers each; helpers have a 30-second deadline. Responses remain no-store, mutations require the existing origin/CSRF admission, and cancellation/logout stops workers.

Authenticated `GET /api/update` reads the shared cached update status and a shell-quoted command for this server executable, with sudo for non-root users. CSRF-protected POST requests a rate-limited check through internal/update. Neither endpoint installs or restarts. The CLI starts the checker with the server lifecycle; failures retain known update availability.

# Work Guidance

Keep frontend protocol and real-system tests in sync. Do not weaken shared ownership checks to accommodate a UI caller.

# Verification

Run `go test ./internal/server` for origin/CSRF/logout admission, connection readiness/authentication, shutdown unavailability/session cancellation, authenticated system information and metrics, process snapshot/CSRF/selection admission, monitoring preference validation, OS-release parsing, whole-grid/file-label validation, and compressed index/CSP integrity. Run with `-race` for lifecycle changes. `TUXEE_SYSTEM_TEST=1 go test ./tests` runs real HTTP/WebSocket takeover, reconnection and no-timeout retention checks against the built executable.

HTTPS redirect checks cover preserved URLs, invalid/oversized headers, plaintext isolation, idle clients, HTTP/2, TLS-ALPN certificate challenges and shutdown. The real-system test follows the redirect through the built binary.

Content APIs use the same authenticated user worker. File-operation JSON is bounded at 8 MiB to accommodate escaped 1 MiB editor pages, including their original byte ranges and hashes. Inline previews allow only selected image/PDF/audio/video MIME types, never HTML/SVG. The /api/preview/{filename}?path= route carries the original filename in its URL and Content-Disposition for native viewers. Responses are private/no-store, use same-origin frames with restrictive CSP, and support validated single byte ranges plus HEAD. The main CSP permits local frames/media for those previews. Test malformed/suffix/open-ended ranges and active-content exclusions.

# Child DOX Index

No children.
