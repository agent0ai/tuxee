# Persistent-terminal PoC

The persistent-terminal implementation keeps terminals, TUIs, X11 applications and shared user audio alive
across **Tuxee** crashes, binary updates and restarts. Browser login sessions still
end. Linux reboot, container restart, deleting the container, killing a guardian
or explicit terminal closure ends the corresponding processes.

Each terminal has one small static C guardian, running as its Linux user. Its
`keeper.sock` lives beside `meta.json`, output and input history under the existing
user terminal directory. Startup uses those directories and the existing account
list; there is no additional terminal catalog. The executable is embedded in
Tuxee and runs from a sealed memfd. Already running guardians retain their original
executable across replacement of Tuxee.

Go still owns terminal interpretation, snapshots, archive policy, GUI discovery,
clipboard, browser audio capture, authentication and browser transport. The guardian
owns processes and descriptors, journals raw PTY bytes, accepts input/resize requests,
and relays established local streams. A pure descriptor keeper cannot preserve
GUI/audio connections if their forwarding process crashes; those relays therefore
must remain in the guardian. A bounded raw journal makes interpreter recovery
consistent even when Go crashes between reading output and checkpointing it.

Protocol 2 is deliberately independent of the application release. Keep its wire
operations compatible and retain readers/migrations for old Go checkpoint schemas.
A future protocol requirement may still require a new helper for **new** terminals;
this PoC cannot prove no helper bug or future requirement will ever need an update.

The raw journal reserves 4 MiB of disk per terminal, immediately unlinks the file,
and applies backpressure when full. It never silently drops output. Mapped journal
pages are reclaimable file cache. Sealed interpreter checkpoints use additional
kernel shared memory, which is **not included in the guardian's process PSS**.
Both survive Go exit through retained descriptors; neither survives Linux reboot.
Graceful detach also flushes the latest interpreted text to the user's `output.txt`.
Abrupt container/Linux loss can still lose output since the last five-second
archive checkpoint; this bounded visual transcript is not an audit log.
Existing browser input pipelining, rendering and keyboard/mouse patches are reused.
Input is not retried after an ambiguous failure; automatic terminal-query replies
are deduplicated by journal offset.
Go watches controller hangup alongside journal notifications, so killing a helper
wakes output, job and listener waiters even when the helper cannot send a final event.
This adds one poll descriptor per controller, with no extra native code or blocked
OS thread per terminal.

One separate audio guardian per Linux user holds the shared PulseAudio runtime.
Terminal-owned pipe references release it after the last terminal ends, even while
Go is absent. Go stops browser capture on disconnect and recreates capture after
login. A retained lock protects temporary audio files; stale files are reclaimed
at the next audio acquisition. Existing X11 windows keep their connections while
Go rebuilds window/clipboard observers. Observer attachment failure does not kill
the running graphical application.

Explicit closure waits for process cleanup. Native code runs without elevated
privileges. Root Go can assist with descendants that changed UID using kernel peer
pidfds and pinned proc descriptors, without accepting user-supplied signal targets.
That assistance requires Linux SO_PEERPIDFD support (Linux 6.5+); on older kernels,
an elevated descendant can prevent successful cleanup. Uninterruptible processes
can also delay termination. Failed cleanup preserves metadata and returns an error.

Build the frontend with `npm run build`, then run
`make -C internal/keeper/native` with musl-tools, make and binutils installed before
building Go. Docker performs that compilation in a separate build stage and adds
no helper runtime packages. The hardened amd64 helper is currently **42,536 bytes**.
The full amd64 image delta against the same base source/build is 260,117 bytes
(about 254 KiB), including all Go integration and notices. In the 32-terminal idle
Docker measurement, guardians total 1,256 KiB PSS (about 39 KiB each), with another
1,044,987 bytes of retained checkpoint memfds (about 32 KiB each). The shared audio
guardian is additional, once per Linux user. These figures exclude shells, GUI/audio
applications and the existing Go terminal engines. A busy journal can occupy up to
4 MiB of reclaimable file cache per terminal; 32 journals reserve 128 MiB of disk.
Raw local echo averaged 0.04–0.06 ms directly and 0.16–0.23 ms through the guardian
in this run. Browser typing/backspace passed at 0/100/200/400 ms simulated RTT.
Two alternating quiet runs of each stripped build measured 9–13 ms median browser
echo for the original and 9–12 ms for the guardian at zero added RTT. Their ranges
also overlapped at 100/200/400 ms RTT; no consistent added browser delay appeared.
These are local PoC measurements, not a performance guarantee.

Live systemd hosts need their existing managed unit refreshed once with
`tuxee service install`, changing `KillMode=control-group` to `KillMode=process`.
The executable updater does not silently rewrite units.

Verification includes real PTY journal replay/backpressure, parser continuation,
checkpoint atomicity, controller-loss relays, pending accepts, malformed requests,
descriptor leaks, elevated-descendant cleanup, GUI observer failures and backend
system tests. `tests/terminal-keeper.mjs` exercises the integrated Docker runtime
with real TUIs, Xterm, browser rendering and audio through crash/replacement cycles.
It subscribes to browser audio before creating the first terminal, covering normal
login ordering as well as restoring existing sessions.
`tests/terminal-latency.mjs` checks browser input under simulated round-trip delays;
`BenchmarkPTYRoundTrip` compares raw local echo with a direct PTY.
`tests/keeper-stress.mjs` compares live screenshots, T snapshots, archive responses
and on-disk text for long/color/Unicode output, prompt boundaries, private per-user
storage and modern TUIs. `tests/terminal-archive-scenarios.mjs` covers four shells,
six classic TUIs, signals, workspace eviction and container loss. Both require a
disposable `tuxee-post-mortem-stress-*` container; see `tests/AGENTS.md` for setup.
The packaged btop requires at least 80 columns and emits literal newlines from
multiline process command lines, which can disturb its layout even in a direct PTY.
The full GUI, clipboard, audio, mobile keyboard/mouse, archive, restart/update and
backend/system suites pass locally, alongside focused race and native sanitizer
checks. The archive suite covers all built-in languages. The live preview also
passes a restart issued from its GUI xterm with the same four terminal PIDs and an
unsaved Micro buffer.

This implementation remains experimental until its native-host checks are complete. Live systemd,
arm64 guardian runtime checks and physical mobile keyboard behavior require their
respective environments. Existing terminals created by builds without guardians
cannot be made crash-safe retroactively.
An abrupt crash during creation, before its cleanup manifest is stored, can leave
temporary prompt/display directories. Scavenging that narrow creation window is
a remaining PoC cleanup limitation.
