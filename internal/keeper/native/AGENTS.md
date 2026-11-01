Parent DOX: [keeper](../AGENTS.md).

# Purpose

Small native process/descriptor guardian, without a Go runtime or product-specific parsers.

# Ownership

Own the C executable and build recipe. Go owns policy, terminal interpretation and persisted snapshot schemas.

# Local Contracts

Use Linux credential checks, close-on-exec descriptors, bounded messages and stable child identity. The guardian survives loss of its controller. Explicit closure must report permission failures instead of abandoning live children. Keep process spawning, FD storage, journals and relays generic; do not parse frontend, GUI or audio state here.

Protocol 2 uses a 32-byte big-endian header: magic `0x54584b32`, operation, payload length, errno, argument and auxiliary. Reply operations set bit 31. Payloads are at most 65,536 bytes with at most four SCM_RIGHTS descriptors. Operations 0–14 are HELLO, GET, PUT, SPAWN, STATUS, SIGNAL, RELAY, READ, COMMIT, INPUT, EVENT, PTY, CLOSE, TRACK and ACCEPT. Keep their numeric assignments stable. Store at most 32 FD slots, 8 job slots, 128 byte relays and 64 lifetime references. Slot 0 is the sealed checkpoint. Journal records use big-endian kind/length followed by opaque bytes; native kinds 1/2/3 are output/end/resize. COMMIT validates record boundaries before swapping cursor and checkpoint atomically.

Keep exited job leaders unreaped until replacement/cleanup to pin process groups. Act as a subreaper and reap all descendants before acknowledging closure. Release directory ownership before the success acknowledgement. ACCEPT retains a pending connection until relay commit or rejection, surviving a controller crash between those operations. Job-owned descriptors close on leader exit; TRACK's last EOF triggers cleanup.

# Work Guidance

Use libc/Linux APIs and hardened static PIE builds. Keep stdout/stderr startup diagnostics separate from the control protocol. Retain every deployed protocol version needed by live sessions, with compatibility checks before changing it.

# Verification

Use the parent package's real-system checks plus compiler warnings, ASan/UBSan and Docker footprint measurements.

# Child DOX Index

No children.
