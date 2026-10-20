Parent DOX: [Docker](../AGENTS.md).

# Purpose

User-facing documentation for Docker's `/init` startup folder.

# Ownership

Own the README copied to `/init/README.md`. Docker owns the init runner and
entrypoint; root owns image and Compose wiring; tests owns startup verification.

# Local Contracts

Top-level, non-hidden `*.sh` files launch independently in parallel as root through
separate Bash processes and process groups alongside Tuxee.
No execution order is guaranteed. Run hooks once per container start, independently
of Tuxee restarts. Scripts may run indefinitely; blocked or failed scripts do not
stop Tuxee or sibling scripts.
The runner waits for active scripts and terminates their groups on shutdown.
Executable permission is unnecessary; the working directory is `/init`.
Failures are logged; completed or failed scripts are not automatically restarted.
Hooks run on every container start, never in native installations.
The entrypoint initializes root before launching hooks and removes `ROOT_PASSWORD`
from their environment.
Long-running services may run directly or use a restart loop. Node/npm and PM2
are not bundled; examples use a foreground executable. The Compose volume persists scripts.

# Work Guidance

Keep examples safe to repeat and consistent with `../docker-init.sh`.
Copy only the runtime README into the image, not this instruction file.

# Verification

Run `npm run test:docker-init` from the repository root. Put Tini
on PATH for continuous hooks alongside the framework, restart and
process-group shutdown checks.

# Child DOX Index

No children.
