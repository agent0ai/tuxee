Parent DOX: [internal](../AGENTS.md).

# Purpose

GitHub release discovery, safe executable replacement, container setup and shared update notices.

# Ownership

Own release validation, downloads, installation, embedded `update.sh`, shared `root-prompt.bash` and the daily check. CLI owns
commands/restart guidance; server and browser expose checks, never installation.

`Command(executable)` is shared by the update API, restart permission guidance and CLI restart hints. Return `tuxee` only when PATH lookup resolves through symlinks to the target installation path; otherwise return the shell-quoted absolute path. Compare paths rather than the running inode so atomic replacement keeps the short command valid. This checks the calling process's PATH, not customized user shell or sudo settings.

# Local Contracts

- Stable releases use `vMAJOR.MINOR.PATCH`; compare semantic versions.
- Fetch only the official repository over HTTPS, with bounded responses/timeouts.
  Resolve a release once and verify its SHA-256 before executing staged code.
- Lock the destination directory, stage beside the target, verify the version,
  sync and rename atomically. Failures before rename preserve the executable.
  Never restart services or silently downgrade; executable replacement preserves configuration and user state.
- Run the separately tracked, embedded `update.sh` on stable-version server startup in Tuxee containers only, after locking state and binding listeners, before accepting requests. Native installs, CLI helpers, checks and development builds do not run it. Keep this release focused on the supplied Debian container; do not add a general migration framework.
- `/usr/local/lib/tuxee/update-version` records successful setup outside persisted volumes. Bake the image version there so new containers skip setup, including with reused data volumes. Run only for a newer binary or a legacy image without the marker; replace the marker only after success. Bound execution to five minutes and cancel its process group on shutdown. Failures log and allow serving, remaining eligible on the next start.
- The script is idempotent: check the private audio wrappers, install only missing prerequisites after a successful `apt-get update`, then fetch the target tag's `tuxee-audio-linux-{amd64,arm64}.tar.gz`. Require one matching SHA-256 entry in `checksums.txt`, verify before extraction, and probe the staged runtime before installing. Keep private audio libraries separate from Debian libraries; no compilers or full audio packages in the container.
- `ensure_bash_keys` appends the Bash Shift+Enter newline binding to `/etc/bash.bashrc` once, preserving existing contents and user startup files. Keep it identical to the fresh-image Dockerfile binding; satisfied audio setup must still reach this step.
- `ensure_root_prompt` atomically installs the embedded `root-prompt.bash` at `/etc/profile.d/zz-tuxee-root.sh`, supplied only to the setup child through `TUXEE_ROOT_PROMPT`. Compare content before writing; preserve other profiles and user startup files. Docker copies this same source directly for new images.
- The root-only interactive Bash prompt is all bold: green `#36cfa7` home-abbreviated path, gold `#fdbc03` active virtualenv/Conda name, purple `#ad94f7` Git branch (short hash for detached HEAD), and default-foreground `❯`. No tags, commit counts, runtimes or marker scans. Keep each Git call bounded to 250 ms and tolerate absent Git. Count the full inline prompt, excluding color codes: below 25 characters use one line; otherwise prepend one blank line and put `❯` on the next line. Reset styling before typed input, honor `NO_COLOR`/`TERM=dumb`, sanitize control characters and expand names as data. Preserve exit status and scalar/array prompt hooks without duplicate registration. Yield when startup files replace PS1; disable virtualenv/Conda's extra environment prefixes while this default supplies the label.
- Default installation is `/usr/local/lib/tuxee/tuxee`, exposed through a symlink
  in `/usr/local/bin`. Named managed services retain their own installation.
  Bootstrap replaces recognized Tuxee binaries at either default path, including
  pre-updater builds, without invoking the old executable's installation commands.
- Check at startup and at 00:01 in the server's local timezone. Coalesce checks
  and allow one attempt per clock minute across all sessions, including failures;
  the limit resets at the next minute boundary. Preserve the last successful
  release on failure and timestamp completed attempts. GitHub failures must not
  interrupt Tuxee.

# Work Guidance

Use the standard library and the existing x/mod semantic-version package.
Maintain one cumulative `update.sh`, with its maintenance rules at the top and
one idempotent `ensure_*` function per requirement, called directly from `main`.
Retain checks needed for skipped releases; inspect current state and required
component versions instead of replaying release history. Ready checks stay local
and cheap, avoiding package queries, apt, network and temporary files. Return from
satisfied checks without skipping later steps; isolate variables, working
directories and cleanup traps in subshell functions. Preserve error propagation.

# Verification

`go test ./internal/update` covers release validation, failure preservation,
checksums, replacement, scheduling, clock-minute boundaries and check concurrency
without public requests. Setup tests cover fresh-image skips, legacy upgrades, completion markers, failure retries and child-process cancellation. `tests/setup.py` exercises the real script in disposable chroots; with `TUXEE_SETUP_TEST_BINARY` pointing to a 0.2.1 build it also checks the embedded script through real server startup. No host installation or public downloads.
`bash tests/root-prompt.bash` checks the shared prompt, length boundaries, colors, Git/environment metadata, literal unsafe names, user overrides, root-only scope and shell-hook behavior. Verify real Docker login-shell startup and wrapped input when changing the profile.
With bin/tuxee built, also verify native bootstrap/reinstallation in temporary paths.
Verify that writable command directories are rejected before installation and
that securing their permissions allows installation and reinstallation.
Cover replacement of regular Tuxee binaries at both legacy default locations
and the resulting PATH symlink to the new executable.

# Child DOX Index

No children.
