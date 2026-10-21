Parent DOX: [project](../AGENTS.md).

# Purpose

Docker runtime support and example configuration.

# Ownership

Own `build-gui.sh`, `entrypoint.sh`, `docker-init.sh`, `tuxee.profile.sh` and
`tuxee.example.json`. Root owns `Dockerfile` and `compose.yaml`; update their
COPY and mount paths when these files move.

# Local Contracts

Keep container paths stable: `/opt/tuxee`, `/etc/tuxee/config.json` and `/init`.
Tini runs as PID 1; `entrypoint.sh INIT_DIRECTORY COMMAND [ARG...]` launches the
init runner once in the background and restarts the command one second after
any exit. INT/TERM stops restarting, terminates job process groups and waits for
shutdown. The init runner forwards shutdown to each script's process group.
Node/npm belong only to the frontend build stage.
Native installations never execute Docker startup scripts or install the shell profile.
The example configuration contains defaults only, never credentials or state.
Use numeric `httpPort: 80` and `httpsPort: 443`, with no legacy bind/http settings.
`TUXEE_HTTP_PORT`/`TUXEE_HTTPS_PORT` override JSON inside the native binary;
zero disables that listener and both zero refuses startup (the existing restart
loop still retries). Empty/invalid values must fail visibly. Match container-side
publications to enabled internal ports and remove disabled mappings; EXPOSE is
metadata only. The image healthcheck uses the binary’s same JSON/environment
parser; custom command-line listener options require matching healthcheck options.

Before launching jobs, the entrypoint initializes root through `chpasswd` stdin
from runtime `ROOT_PASSWORD` (unset defaults to `toor`). Reject empty values and
CR/LF; failure aborts startup without marking success. Keep the completion marker
beside the entrypoint at `/opt/tuxee/.root-password-initialized`, outside volumes,
so it shares the account database's container lifecycle. Restarts preserve later
password changes; new containers initialize again. Unset the password before jobs
inherit the environment. Do not bake custom passwords into image layers.

The image exposes `/usr/local/lib/tuxee/tuxee` through `/usr/local/bin/tuxee`. The updater replaces that file without restarting. Updates in the writable layer survive same-container restarts, but recreation uses the image version. Compose defaults to the published multi-platform image; root release automation owns image tags.

GUI/frontend/runtime stages use Debian Trixie variants; runtime uses `debian:trixie-slim`. The Bookworm Go builder preserves the native Debian 12 compatibility baseline. The `build-gui.sh OUTPUT` downloads SHA-256-pinned TigerVNC 1.16.2 and Xorg 21.1.25, applies the matching upstream integration patch, and builds stripped `tuxee-Xvnc`/`tuxee-vncpasswd` with GLX/DRI/glamor/viewer disabled. Keep compilers and source in the `gui` build stage; copy only binaries and upstream licenses into runtime. Preserve the no-GL/EGL/GBM/LLVM/missing-library dependency check. Runtime uses Matchbox, xterm, DejaVu fonts, X authentication/keyboard data and session D-Bus with no recommends. It needs no Python/Node/websockify, GPU device, privileged mode or public VNC port. Document app-specific dependencies separately.

# Work Guidance

Keep runtime files here and keep the root Docker/Compose entry points usable.

# Verification

`npm run test:docker-init` exercises the runner, first-run credentials with isolated
account files when root, and, with Tini on PATH, the production entrypoint lifecycle.
`npm run test:features` checks the shell profile with a dedicated user.
Run `sh docker/build-gui.sh OUTPUT` with the GUI build-stage dependencies to validate the pinned source recipe and its dependency assertion. Full image build and lifecycle checks require Docker.

# Child DOX Index

- [init/AGENTS.md](init/AGENTS.md): `/init/README.md` and startup-script contracts.
