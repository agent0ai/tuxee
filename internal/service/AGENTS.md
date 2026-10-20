Parent DOX: [internal](../AGENTS.md).

# Purpose

Native systemd registration and lifecycle commands.

# Ownership

Own unit generation, stable executable installation, and delegation to systemctl/journalctl. The CLI owns configuration values.

# Local Contracts

Require a running systemd manager before installation or lifecycle changes. Use a named, marked unit and refuse unrelated files. Install atomically; preserve existing configuration and all state on uninstall. Run as root because PAM and per-user process credentials require it. No custom background supervisor.

Keep a protected installation marker beside the installed executable so unregistering and reinstalling remains safe without discarding preserved files.

# Work Guidance

Use a dedicated service name for tests. Never alter host sshd or unrelated services.

# Verification

Run `go test ./internal/service`. Unit tests exercise temporary installation paths, reinstall safety, systemd quoting and `systemd-analyze verify` when available. Real lifecycle checks require systemd as PID 1.

# Child DOX Index

No children.
