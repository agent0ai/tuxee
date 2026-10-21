Parent DOX: [project](../AGENTS.md).

# Purpose

Native backend and Linux integration.

# Ownership

This document owns this subtree.

# Local Contracts

User filesystem operations, process discovery and process signals execute in credential-dropped child processes. Shared Go server identity never changes. Terminal lifetime is separate from authentication/view lifetime. WebSocket views attach directly to local PTYs; there is no SSH listener. TLS continues with a persisted local CA when public issuance is unavailable.

# Work Guidance

Keep implementation and checks small and complete.

# Verification

Run `go test ./internal/...`; use `go test -race ./internal/...` for lifecycle and transport changes. Set `TUXEE_SYSTEM_TEST=1` as root for dedicated Linux account checks.

# Child DOX Index

- [terminal/AGENTS.md](terminal/AGENTS.md): Retained PTYs, display interpreter, attachments, and explicit termination.
- [desktop/AGENTS.md](desktop/AGENTS.md): Lazy terminal X/VNC/audio runtimes, native window discovery, credentials and process cleanup.

- [identity/AGENTS.md](identity/AGENTS.md): PAM authentication and Linux process credentials.
- [files/AGENTS.md](files/AGENTS.md): Credential-dropped filesystem workers and settings.
- [tlsmanager/AGENTS.md](tlsmanager/AGENTS.md): ACME and local-CA certificate lifecycle.
- [monitor/AGENTS.md](monitor/AGENTS.md): Cached Linux CPU, memory, swap, filesystem and network metrics with container accounting.
- [processes/AGENTS.md](processes/AGENTS.md): On-demand process trees, bounded grouping, stable user-scoped signals and runtime signal-permission checks.
- [server/AGENTS.md](server/AGENTS.md): HTTP sessions, APIs, and browser terminal transport.
- [service/AGENTS.md](service/AGENTS.md): Native systemd registration and lifecycle commands.
- [update/AGENTS.md](update/AGENTS.md): Official releases, verified replacement, versioned container setup and daily update status.
