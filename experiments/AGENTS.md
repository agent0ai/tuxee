Parent DOX: [project](../AGENTS.md).

# Purpose

Isolated, reproducible experiments before production integration.

# Ownership

Own experimental sources and their checks. Production code remains in its existing domains.

# Local Contracts

Keep generated binaries, measurements and logs in the repository's ignored `test-results/` directory. Do not change production behavior merely to run an experiment. Report measured limits separately from production guarantees.

# Work Guidance

Use disposable containers and real Linux primitives. Preserve validation and lifecycle correctness when minimizing size.

# Verification

Use each experiment's documented checks.

# Child DOX Index

- [terminal-keeper/AGENTS.md](terminal-keeper/AGENTS.md): Minimal native PTY ownership, descriptor transfer, crash recovery and Docker footprint measurements.
