Parent DOX: [internal](../AGENTS.md).

# Purpose

Native systemd registration and lifecycle commands.

# Ownership

Own unit generation, stable executable installation, and delegation to systemctl/journalctl. The CLI owns configuration values.

# Local Contracts

Require a running systemd manager before installation or lifecycle changes. Use a named, marked unit and refuse unrelated files. Install atomically; preserve existing configuration and all state on uninstall. Run as root because PAM and per-user process credentials require it. No custom background supervisor.

Keep a protected installation marker beside the installed executable so unregistering and reinstalling remains safe without discarding preserved files.

The release installer places the default executable at `/usr/local/lib/tuxee/tuxee` and exposes it on PATH by symlink. Registration may adopt that same executing inode without a prior marker; unrelated files remain protected. Named services retain separate copies. `Executable(name)` validates a managed unit before the updater selects its installation.

Serialize executable writes with the updater's `LockDirectory`; service
registration must not race bootstrap or version replacement.

# Work Guidance

Use a dedicated service name for tests. Never alter host sshd or unrelated services.

# Verification

Run `go test ./internal/service`. Unit tests exercise temporary installation paths, reinstall safety, systemd quoting and `systemd-analyze verify` when available. Real lifecycle checks require systemd as PID 1.

# Child DOX Index

No children.
