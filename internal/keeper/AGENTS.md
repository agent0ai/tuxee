Parent DOX: [internal](../AGENTS.md).

# Purpose

Linux terminal ownership that survives the Go server, with a small native guardian and a versioned local protocol.

# Ownership

Own credential-dropped directory/socket access, embedded helper execution, descriptor transfer, bounded output journals, process handles and generic connection retention. Terminal, desktop and audio retain their application-specific behavior in Go.

# Local Contracts

- Discover one terminal through its existing private metadata directory and `keeper.sock`; do not introduce a terminal registry. Authenticate Unix peers and preserve Linux UID/GID/groups. All user-path lookup/open operations occur in a credential-dropped worker; Go may use the resulting already-authorized descriptors.
- Native code knows only processes, descriptors, raw bytes and opaque journal entries. It does not parse terminal escape sequences, snapshots, X11, VNC, audio or application settings.
- Protocol 2 uses fixed-width network-order messages and SCM_RIGHTS. Reject unknown operations/versions without killing running sessions. Keep native protocol compatibility independently of Go snapshot versions. Existing helpers retain their original executable across updates; attach using their advertised protocol, never replace a live helper to upgrade the server.
- Keep raw output until Go atomically commits a corresponding interpreter checkpoint. Apply backpressure when the bounded journal is full; never silently drop terminal bytes. Input is accepted once and never automatically retried after an ambiguous connection failure. Keep query-reply deduplication independent of snapshot replay.
- Retain connected GUI/audio streams through generic byte relays; Go owns lazy startup, credentials, window management, clipboard, capture and browser transport. Closing a Go connection detaches; explicit terminal closure terminates its owned process family.
- Embed a hardened static musl PIE and launch it from a sealed executable memfd. The retained inode is independent of the mutable main executable. Generated embedded helper builds are ignored by Git. Never invoke a compiler or install packages at runtime.

- The 4 MiB journal is an immediately unlinked, preallocated file in the terminal metadata directory. Its mapped pages are reclaimable file cache. Checkpoints are sealed memfds: account for their shmem separately from guardian PSS. Neither is a Linux-reboot persistence mechanism.
- Native cleanup is unprivileged. If descendants changed UID, root Go may assist using SO_PEERPIDFD and pinned proc descriptors, deriving children only from the kernel. Older kernels without SO_PEERPIDFD cannot provide this assistance; report failure and preserve metadata. Never trust protocol-supplied PIDs for privileged signals.
- Build before Go compilation: `make -C internal/keeper/native` with musl-tools, make and binutils. Docker supplies a separate native builder and adds no guardian runtime packages.
- Go watches both journal notifications and controller socket hangup through its poller. Guardian death must wake output, process and accept waiters even with no further request or eventfd write; do not add polling intervals or a blocked OS thread per helper.

# Work Guidance

Prefer generic, bounded primitives needed by current callers. Avoid embedding product policy or version-specific renderer state in the native ABI. Preserve validation, process identity and shutdown error handling while measuring size and memory.

# Verification

The shared client/benchmark fixture requires root to launch credential-dropped workers; skip it explicitly otherwise. Run `go test ./internal/keeper` as root for helper coverage. Elevated-descendant cleanup additionally requires `TUXEE_SYSTEM_TEST=1` and the dedicated `tuxee-poc-desktop` account.

Run package tests with real PTYs and native helpers, including server-client SIGKILL, journal/checkpoint recovery, malformed protocol, peer permissions, descriptor leaks, process cleanup and byte-exact relays. Run the existing terminal, GUI/audio and browser regression suites after integration; keep browser suites sequential.

# Child DOX Index

- [native/AGENTS.md](native/AGENTS.md): Native Linux guardian and its stable wire/journal formats.
