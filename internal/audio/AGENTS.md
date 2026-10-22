Parent DOX: [internal](../AGENTS.md).

# Purpose

Private per-user audio for retained terminals and GUI applications.

# Ownership

Own lazy PulseAudio endpoints, user credentials, shared capture, silence suppression and bounded listener queues. Terminal owns terminal references; server owns authenticated browser subscriptions.

# Local Contracts

- One runtime per Linux UID within a terminal manager. Give all shells the same private PULSE_SERVER/PULSE_COOKIE. Start PulseAudio on the first credential-checked application connection, independently of X11. Keep the public parent and credentials stable, allow only user-owned runtime state, and verify the upstream socket UID before forwarding bytes. Never use host sound devices or TCP listeners.
- Use one capture while any browser listens. Muting/logout removes only that listener; the last listener stops capture while preserving applications. The last terminal stops the audio runtime. Manager shutdown reaps all processes and removes private files.
- Stream 48 kHz stereo signed 16-bit little-endian PCM in 960-frame packets, prefixed by a little-endian uint64 sample position. Omit only all-zero PCM packets; retain positions across silence. A new capture starts at position zero. Disable null-sink rewinds so capture preserves initial samples. Bound each listener queue and disconnect slow listeners.
- Keep capture ready before forwarding the first application connection when a browser is listening. Never stop capture merely because the output is silent.

# Work Guidance

Reuse Linux identity credentials and PulseAudio's mixer; add no codec or runtime dependency.

# Verification

`TUXEE_SYSTEM_TEST=1 go test -race ./internal/audio ./internal/terminal ./internal/server` and `npm run test:audio` with the optional runtime on PATH.

# Child DOX Index

No children.
