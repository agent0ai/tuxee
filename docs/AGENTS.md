Parent DOX: [project](../AGENTS.md).

# Purpose

Detailed product, deployment and development documentation.

# Ownership

`install.md` owns the installer,
manual binary download/installation commands, and advanced Go compilation.
`guide.md` owns deployment, interaction, verification and implementation limits.
`releases.md` owns updates, GitHub/Docker Hub setup and publication limits.
`audio.md` owns shared user audio, reproduction commands, measured runtime footprint and validation limits.
Root `README.md` owns the logo/title, short container/standalone introduction,
illustrated Highlights, Quick start, Resources links and Agent Zero credits.

# Local Contracts

Run documented shell commands from the repository root unless stated otherwise.
Resolve documentation links relative to their containing file.
Keep verified behavior separate from limitations; do not claim checks ran merely
because their commands are documented.

# Work Guidance

Keep ordinary deployment zero-configuration: start the supplied image, forward proxies to HTTP 80 and persist data independently. Never prescribe per-domain origin values, ACME changes or host config files for reverse proxies. Put custom JSON/listener choices under optional configuration. Keep operational details here and link them from the root README. `guide.md#listening-ports` owns independent port defaults/zero semantics, precedence, legacy-mode migration, HTTP/proxy security and internal versus published ports. Keep Docker examples and CLI help consistent; never imply nonstandard public HTTPS ports satisfy TLS-ALPN-01 validation.

Document `tuxee ports` as editing saved configuration, with explicit restart and startup override precedence. Use `--config` for named/custom installations; distinguish container listening ports from host-published ports and container restart from recreation.

# Verification

Use the build commands in `install.md` and verification commands in `guide.md`.

# Child DOX Index

No children.
