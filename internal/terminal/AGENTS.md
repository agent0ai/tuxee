Parent DOX: [internal](../AGENTS.md).

# Purpose

Retained Linux PTYs and canonical display recovery.

# Ownership

Own session identity, process groups, bounded output, browser controller leases, and explicit termination. Shells use local PTYs without an SSH transport. Each session owns an optional lazy internal/desktop display and a reference to the manager's shared internal/audio runtime for its Linux UID. Prepare both environments before starting the shell. Close the display and release the audio reference after shell exit; explicit closure waits for that cleanup. All sessions for one UID receive the same PulseAudio endpoint, including when X11 is unavailable.

# Local Contracts

Start shells with `umask 022` in the credential-dropped child before login startup files run, for both interactive and command terminals. System/user shell profiles may override it; commands and GUI apps inherit the resulting mask. Keep the server's `077` mask and private helper/runtime files unchanged. Exec the selected shell in place to preserve the tracked PID and process-group cleanup.

`shell.go` embeds the small shell startup/prompt scripts. Shell command defaults to `bash`; interpret its executable/arguments only in the credential-dropped child, never in the server. Set SHELL to the selected executable. Ordinary interactive shells use login startup; command terminals use `-lc` without prompt injection. Missing shells fail visibly; never install a shell or silently substitute one.

The per-user prompt preference defaults on and affects only new interactive Bash, Zsh and Fish terminals. Write embedded scripts into a private per-session directory under `/tmp`, readable by its owner; remove it after shell exit or failed creation. Bash uses `--rcfile` and explicitly sources `/etc/profile` plus the first readable `.bash_profile`, `.bash_login` or `.profile`, then the app prompt. This mode is interactive rather than Bash's `login_shell` mode. Zsh temporarily redirects ZDOTDIR through startup wrappers, sources the user's files and restores ZDOTDIR before the prompt; Fish uses its native `--init-command`. Other shells retain their own prompts. Startup-disabling flags may bypass shell integration. Never edit user startup files, change their login shell, add prompt dependencies or install global profiles.

`prompt.bash`, `prompt.zsh` and `prompt.fish` show a bold green `#36cfa7` home-abbreviated path, gold `#fdbc03` active virtualenv/Conda name, purple `#ad94f7` Git branch (short hash when detached), and default-foreground `❯`. Count the full inline text without color codes: below 25 characters stays inline; otherwise prepend a blank line and put `❯` on the second line. Bound Git calls to 250 ms, tolerate absent Git, sanitize control characters and render names as data, including Zsh percent escapes. Reset color before input, honor NO_COLOR/TERM=dumb, preserve existing prompt hooks and avoid duplicate environment labels. No runtimes, tags or commit counts.

Attachment loss never kills a shell. There is no idle or detached timeout. Explicit termination, process exit, unrecoverable terminal failure, and server shutdown end it. User ownership is checked before attachment and control.

Ended processes retain their terminal output until their session is explicitly closed; a new attachment receives its snapshot followed by an exit event. The frontend must persist a new session ID before connecting, and coalesce creation while its panel is being remounted.

Serialize process-group signals with child reaping. Never signal a retained terminal's numeric PID after it has exited and been reaped.

Manager.Close waits for every session's cleanup, including sessions already removed from the visible inventory by a concurrent Close. Force-killed shells must be reaped and their displays closed before cleanup completes, so runtime re-execution cannot strand child processes.

Snapshot capture is admitted before allocation: at most two unacknowledged recoveries globally and 32 queued requests. Waiting is context-cancellable; release admission on snapshot acknowledgement or transport closure, including failed capture. Serialized snapshots are limited to 64 MiB separately from each attachment's 1 MiB/512-event live queue. Queue accounting includes events already sent but not rendered. Slow views detach without terminating the PTY; input cancellation never implies that accepted bytes can be replayed.

Display/window state travels in the initial snapshot and subsequent `display` events on the existing terminal attachment. Include window metadata in attachment queue byte limits. The browser can hide either renderer without detaching or terminating the PTY.

Create initializes the canonical background and foreground before shell startup. Manager.SetBackground applies changed background/foreground preferences to every owned retained session, including detached/ended sessions, under its output lock and broadcasts an ordered `background` event. Keep the current/default background and foreground in snapshots and application query/reset replies. Unchanged preferences preserve application overrides; ANSI palette entries, parser state, shell identity and other users stay untouched. Engine update errors use existing terminal error events without undoing saved settings.

# Work Guidance

Reuse the8020 kernel lifecycle and dev-core engine contracts.
`engine.js` is generated by `npm run build` from `web/terminal/runtime.ts`;
do not edit or commit it.

# Verification

Run `go test ./internal/terminal -v`. Engine checks cover split Unicode, two-column emoji/cursor replies using the shared Unicode 11 provider, parser continuation, alternate screen, query replies, synchronized-output deadlines and snapshot recovery. Root-only real PTY checks cover PID retention, takeover, indefinite detachment, explicit termination and manager shutdown waiting for an already-closing HUP-resistant shell to be reaped. Snapshot tests cover serialized byte limits, global admission/waiter bounds, cancellation and release on acknowledgement/closure. Use `-race` for lifecycle changes.

`TestShellPrompt` uses real credential-dropped PTYs for Bash/Zsh/Fish, enabled/disabled prompts, startup files, selected SHELL and retained PID. `TestPromptLengthsAndLiteralNames` checks 24/25/26 characters, Unicode and literal unsafe names across installed shells; optional Zsh/Fish checks skip when unavailable. `bash tests/shell-prompt.bash` checks detailed Bash colors, metadata and hook behavior. `node tests/shell-settings.mjs` verifies settings through the real browser/API.

`TestShellUmask` covers interactive/command root shells, an unprivileged shell, child commands, login-profile overrides, file/directory modes, unchanged shell PID and the server's private mask.

`go test ./internal/terminal -run '^$' -bench BenchmarkSnapshotCapture -benchtime=3x` measures server snapshot capture time and allocations for 5,000 lines at 80 columns and 2,000 at 240 columns. Setup/output parsing is excluded; this is not a network or browser measurement.

# Child DOX Index

No children.
