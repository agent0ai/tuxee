Parent DOX: [experiments](../AGENTS.md).

# Purpose

Measure the smallest reliable native terminal keeper before integrating it into Tuxee.

# Ownership

Own the C helper, Linux/Docker experiment and client test harness. This is not yet the production terminal backend.

`demo.py` is an interactive Python client for a disposable Tuxee container, exposed there as `keeper-demo`. It uses the real Tuxee browser terminal as its outer transport, so it can demonstrate an actual Tuxee crash/re-exec without implementing a second web server. Its extra Python/outer-PTY cost is demonstration overhead and is not included in keeper footprint measurements. `Ctrl+]` kills the client; shell `exit` closes the helper. Outer terminal closure only detaches this explicit demo client, like a multiplexer; it does not change production closure behavior.

# Local Contracts

- Keep only shell/PTY ownership and a private Unix control socket in the helper. Tuxee creates the PTY, reads/writes the transferred master directly, resizes it and owns display interpretation. No proxy, output buffer, renderer, Go runtime or garbage collector in the helper.
- Start under the terminal user's UID/GID/groups, desired shell cwd and clean environment, with an absolute command path. Inherited descriptors are master 3, slave 4 and metadata directory 5. The helper validates them and closes unrelated inherited descriptors. The caller closes its startup descriptors after launch. Linux 5.9+ with `/proc/thread-self/children` is required; `close_range` prevents accidental descriptor leakage.
- Supply a private stderr pipe at startup: diagnostics mean failure, and empty EOF means the helper has completed startup and detached its stdio. Bound this wait and then verify the socket peer PID matches the launched helper. Path existence alone cannot establish readiness because a previous crashed keeper can leave a stale socket.
- Prepare the terminal's metadata before starting its helper. Disable parent-death signalling on the keeper launch itself; the keeper defensively clears it too, but cannot prevent a signal delivered before its first instruction. Keep the ordinary credential helper's parent-death policy unchanged. The shell has a parent-death signal tied to its keeper.
- Bind `keeper.sock` in the existing private terminal metadata directory, `~/.local/state/tuxee/terminals/<id>/` (or its resolved XDG location). Directory locking prevents competing keepers; do not create another catalog. Bind/listen on `keeper.sock.new` and rename it to publish a ready endpoint. A directory descriptor avoids Unix socket path-length limits.
- A same-user or root connection receives a 16-byte network-order header: version 1, shell PID, flags (1=exited, 2=signal exit, 4=busy), exit status. An available connection also receives the PTY master with SCM_RIGHTS. Only one control lease exists. Close the received master before the control connection; then another client may attach. A crashed client's descriptors close automatically. Descriptor transfers cannot revoke a handle deliberately retained by a misbehaving same-UID client.
- Control byte `X` explicitly terminates the session. Disconnect only detaches. Shell exit sends a status packet and retains the PTY until the client drains final output and closes explicitly. Subreaping owns orphan descendants, including `setsid` jobs. Reap exits promptly. During closure, signal only direct children before reaping them, so their PIDs cannot be reused; kill/reap newly adopted descendants until none remain. No detached timeout. An ended, unacknowledged terminal retains one helper and its PTY, but no zombie shell.
- The helper never drains output. During server downtime, the bounded kernel PTY buffer applies backpressure; it does not promise unlimited progress. Bytes already read by a server before it crashes require server-side checkpoint/replay design. Exact screen recovery, GUI/audio, production discovery/reconciliation and systemd lifetime are not implemented by this experiment.
- An independent helper survives the server, not a container shutdown, helper failure or host reboot. Production systemd control-group cleanup needs a separate decision before shipping.
- Closure tests cover same-user descendants. A helper cannot override Linux signal permissions for a child that becomes another UID, and uninterruptible tasks may not exit promptly. The prototype can wait in cleanup in those cases; production needs permission-failure reporting and coordination with its privileged lifecycle owner. Do not ship it as a replacement for Tuxee's existing cleanup contract yet.

# Work Guidance

Compare hardened libc builds using measured binary bytes and PSS/private memory, including multiple idle sessions. Prefer standard libc/Linux APIs over custom runtime or ELF tricks. Keep security checks and error handling.

Use `keeper-musl` (static PIE) for the prototype runtime: no extra runtime package, with ASLR, non-executable stack, RELRO and stack protection. The fixed-address musl and static glibc builds are comparison artifacts only. Copy musl's copyright with the static helper. PSS/private figures cover the helper's user-space mappings, excluding shells, PTY/socket kernel allocations, process kernel stacks and page tables.

# Verification

- Run `DOCKER_HOST=unix:///root/.docker-dev/docker.sock python3 experiments/terminal-keeper/docker-check.py` from the repository root. It builds all variants, tests them, measures the incremental production-image bytes including the musl notice, and runs a server fixture under the real Tuxee entrypoint through ten SIGKILL/restarts and atomic helper replacement. It removes its disposable containers and volumes. The fixture exercises directory-based discovery; it is not the production Go HTTP server.
- `check.py BINARY...` exercises real PTYs, descriptor passing, SIGKILL of the owning client, exact-byte recovery, 64 MiB backpressure, direct resizing/Ctrl+C, 100 reconnects, exclusive attachment, malformed commands, cross-user denial, private/stale-path handling, long metadata paths, orphan reaping, detached descendant cleanup, ASLR and latency against direct PTYs. Root enables UID checks. It makes itself a subreaper for test cleanup.
- `TUXEE_KEEPER_TEST_BINARY=/absolute/helper go test -race ./experiments/terminal-keeper/client` verifies the actual Go `*os.File`/poller/deadline and `creack/pty` resize operations through transferred descriptors, including detach/reattach and explicit termination. Build helpers with `make -C experiments/terminal-keeper` using GCC and musl-tools.
- Compile `keeper.c` with GCC `-fanalyzer`, and with `-fsanitize=address,undefined -fno-omit-frame-pointer`; run `check.py` against the instrumented build. GCC's descriptor analysis reports the intentionally retained stdio `dup2` handles; inspect these rather than treating them as runtime leaks. The inherited-handle check and fixed descriptor counts cover real leaks. Sanitizer memory figures are not footprint results.
- Save generated binaries, raw JSON measurements and build logs under ignored `test-results/terminal-keeper/`. These checks do not establish full terminal-interpreter recovery, GUI/audio survival, live systemd or arm64 runtime behavior.
- For the browser demo, start `tuxee:terminal-keeper-lifecycle-checks` as container `tuxee-terminal-keeper-demo` with `--network none` and command `/usr/local/bin/tuxee serve --http-port 80 --https-port 0 --acme off`. Copy `demo.py` into `/experiment/`, make it executable and symlink it as `/usr/local/bin/keeper-demo`. Use the workspace forwarding helper from container port 80 to local port 18085. The isolated image's default login is root/toor; do not use shared installations or host accounts.
- `node experiments/terminal-keeper/demo-check.mjs` uses Chromium and this exact disposable container to verify actual Tuxee SIGKILL and CLI re-exec, new login/client attachment, unchanged helper/Bash PIDs and retained shell variables. It leaves a live demo workspace and screenshots/JSON in `test-results/terminal-keeper/`. It does not implement production terminal adoption or full screen recovery. The browser client remains the ordinary shipped Tuxee UI; demo copy is terminal application output.

# Child DOX Index

No children.
