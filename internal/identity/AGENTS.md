Parent DOX: [internal](../AGENTS.md).

# Purpose

Linux account lookup, isolated PAM authentication, and child-process identity.

# Ownership

Own the authentication helper and the sole process-credential constructor used by files, terminals and process controls.

# Local Contracts

Passwords travel only through transient stdin to a short-lived PAM helper. Perform both PAM authentication and account checks. Never change the shared server's identity. Child environments contain a fixed safe PATH and the account's HOME/USER/LOGNAME/SHELL, not server environment secrets. Include supplementary groups. PAM policy defaults to the host's login service.

`identity.Self` is `/proc/self/exe`. Authentication, file and process-worker launches use this running inode, never the mutable installation pathname, so binary updates cannot mix helper versions before restart.

# Work Guidance

Use libc/NSS and PAM instead of parsing password hashes. Reject non-login shells. Bound concurrent authentication at the server boundary.

# Verification

Run `TUXEE_SYSTEM_TEST=1 go test ./internal/identity -v` as root. It creates only marked `tuxee-poc-a`/`tuxee-poc-b` accounts, generates a password in memory, checks PAM success/failure, cross-user file denial and supplementary-group permissions. The first account joins the second account's test group. Tests refuse unrelated existing accounts.

# Child DOX Index

No children.
