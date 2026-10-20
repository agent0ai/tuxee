Parent DOX: [internal](../AGENTS.md).

# Purpose

GitHub release discovery, safe executable replacement and shared update notices.

# Ownership

Own release validation, downloads, installation and the daily check. CLI owns
commands/restart guidance; server and browser expose checks, never installation.

# Local Contracts

- Stable releases use `vMAJOR.MINOR.PATCH`; compare semantic versions.
- Fetch only the official repository over HTTPS, with bounded responses/timeouts.
  Resolve a release once and verify its SHA-256 before executing staged code.
- Lock the destination directory, stage beside the target, verify the version,
  sync and rename atomically. Failures before rename preserve the executable.
  Never restart services, change state, or silently downgrade.
- Default installation is `/usr/local/lib/tuxee/tuxee`, exposed through a symlink
  in `/usr/local/bin`. Named managed services retain their own installation.
- Check at startup and at 00:01 in the server's local timezone. Coalesce checks,
  rate-limit manual requests and preserve the last successful result on failure.
  GitHub failures must not interrupt Tuxee.

# Work Guidance

Use the standard library and the existing x/mod semantic-version package.

# Verification

`go test ./internal/update` covers release validation, failure preservation,
checksums, replacement, scheduling and check concurrency without public requests.
With bin/tuxee built, also verify native bootstrap/reinstallation in temporary paths.
Verify that writable command directories are rejected before installation and
that securing their permissions allows installation and reinstallation.

# Child DOX Index

No children.
