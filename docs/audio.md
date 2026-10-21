# Minimal GUI audio experiment

The smallest working candidate tested is a private, stripped PulseAudio build
feeding raw PCM through Tuxee's authenticated WebSocket transport. The browser
plays it with native Web Audio. TigerVNC/noVNC still handles the picture and input.
No FFmpeg, GStreamer, WebRTC stack, frontend package or sound device is needed.

## Footprint

Measurements are incremental to the existing GUI build. MB below means decimal
bytes; MiB means 1,048,576 bytes. Source builds were measured on **arm64 Debian
Bookworm**, not in the final Trixie Docker image.

| Candidate | Added runtime | Result |
| --- | ---: | --- |
| Debian PulseAudio packages | 154.15 MiB arm64 / 164.99 MiB amd64 | Dependency simulation only; broad codec/plugin dependencies |
| Debian PipeWire + Pulse compatibility, capture, routing and ALSA | 50.24 MiB arm64 / 43.15 MiB amd64 | Dependency simulation only, avoiding systemd |
| Minimal source-built PipeWire 1.4.2 | 3,191,320 bytes selected binaries/libraries | Compiled, but still excludes capture/policy integration; no end-to-end result |
| Direct ALSA file output | No separate server | Chromium's AudioContext ran but the output contained zero captured bytes; rejected |
| **Minimal source-built PulseAudio 17.0** | **2,261,497 bytes (2.26 MB / 2.16 MiB)** | Real GUI Chromium → virtual sink → Tuxee → frontend stereo playback |

The PulseAudio output includes executables, private libraries, module dependencies,
wrappers and licenses. Its reproducible tar compresses to **717,186 bytes** with
gzip level 6. This is a compressed artifact measurement, not a measured Docker
registry layer. `tests/audio-size.py` excludes duplicate library symlinks and
rejects accidental headers/static libraries/object files.

Compared with the inherited worktree state, the stripped Go binary grew by
65,568 bytes (4,927 bytes when each binary is gzip-compressed at level 9). That
already includes the frontend's 3,020-byte increase, or 866 bytes gzip. Combined
with the separate runtime, the measured added files total **2,327,065 bytes
(2.33 MB)**. The frontend has no new npm dependency or separate production asset.

The Docker recipe adds no Debian runtime packages. A separate build stage compiles
PulseAudio and libsndfile with optional features disabled, then copies only
`pulseaudio`, `pacat`, the native Unix protocol and null-sink modules, their private
libraries and licenses. The output uses libc, libm and libcap already present in
the image. A dependency check rejects unexpected libraries. Private wrappers keep
the stripped libraries out of other applications' library search paths. Build
tools, source and caches remain in the build stage.

Release builds also publish this exact runtime as a checksum-verified archive
for each architecture. On the first start after an in-container binary upgrade,
the embedded `internal/update/update.sh` installs it if missing. New containers
already carry the runtime and completion marker, so skip setup. See
[Docker updates](releases.md#docker-updates) for failure/retry behavior. Native
installations still require manual audio runtime setup.

The much larger Debian package estimates came from `apt-get --simulate` with
`--no-install-recommends`, subtracting the existing Docker runtime dependency
closure. They are sums of Debian `Installed-Size` metadata, not filesystem or
image measurements. Actual application installs can already include some of them.

## Behavior and tradeoffs

Each terminal gets its own PulseAudio server with a private Unix socket and cookie,
running as the signed-in Linux user. It starts with the lazy X runtime. No audio
process starts for an ordinary shell. Applications receive stable `PULSE_SERVER`
and `PULSE_COOKIE` environment values. Applications must support PulseAudio;
ALSA-only applications are not covered by this stripped runtime.

Audio is enabled by default, including after reload. Each GUI window dropdown
and context menu offers **Mute** or **Unmute**, controlling the shared audio of
that terminal. There is no standalone sound button. If the browser blocks
autoplay, a normal click or keypress in Tuxee unlocks playback; capture starts
only after playback is allowed (see [browser autoplay policy](https://developer.chrome.com/blog/autoplay#web-audio)). Explicit mute lasts for the mounted view, including
window updates and runtime relaunch. Muting, reload and logout stop the old
capture; logout preserves the GUI application and audio server. Terminal closure and empty-display release
stop the runtime. Audio is independent of selecting the shell versus the GUI and
remains enabled in a warm mounted workspace. Each listener has its own stream.

Transport is 48 kHz, stereo, signed 16-bit little-endian PCM in 20 ms packets:
**192,000 bytes/s, or 1.536 Mbit/s**, before transport overhead. This minimizes
installed code at the cost of bandwidth. There is no codec or decoding dependency.
Playback uses native AudioBufferSourceNodes and also works on insecure HTTP
origins. It initially buffers 120 ms, caps the queue at 200 ms and recovers after
a stalled main thread. A stall longer than the queued audio can cause a gap.
Audio and VNC have independent clocks; this is not an audiovisual synchronization
protocol. WAN lip-sync and sustained congested links need separate validation.

The synthetic capture probe used about 1.9 MiB RSS for PulseAudio; real Chromium
playback used about 6 MiB combined RSS for PulseAudio and capture. These are
snapshots, not peak memory or a promise for every workload. Browser/app memory is
additional.

## Reproduce

From the repository root, with the existing GUI/runtime dependencies installed:

```sh
sudo apt-get install --no-install-recommends ca-certificates curl build-essential \
  cmake ninja-build meson pkg-config libltdl-dev libcap-dev
sh docker/build-audio.sh .tools/audio/runtime
python3 tests/audio-size.py .tools/audio/runtime
npm run build
.tools/go/bin/go build -trimpath -ldflags='-s -w' -o bin/tuxee ./cmd/tuxee
PATH="$PWD/.tools/audio/runtime/usr/local/bin:$PATH" npm run test:audio
PATH="$PWD/.tools/audio/runtime/usr/local/bin:$PATH" TUXEE_AUDIO_HTTP=1 npm run test:audio
PATH="$PWD/.tools/audio/runtime/usr/local/bin:$PATH" TUXEE_SYSTEM_TEST=1 \
  GOMAXPROCS=2 .tools/go/bin/go test -race -p 2 ./internal/desktop ./internal/terminal ./internal/server
PATH="$PWD/.tools/audio/runtime/usr/local/bin:$PATH" npm run test:gui
```

Browser suites require root, Chromium, the existing GUI test dependencies and a
marked `tuxee-poc-audio` account (created by the audio test if absent). They change
only that test account's password, restore its settings and clean their isolated
service and applications. Run browser suites sequentially. The HTTP test uses a
non-loopback address and asserts that the browser does not consider it a secure
context. The HTTPS continuity observer is test-only and uses a CSP bypass for its
injected worklet; production uses neither that bypass nor a worklet.

Artifacts are `test-results/audio-{https,http}.json`, desktop/mobile screenshots
and failure diagnostics. The test sends distinct 440 Hz/880 Hz channels from a
44.1 kHz source in real remote Chromium, then measures actual 48 kHz frontend
output. It exercises default-on playback, GUI-window Mute/Unmute menus, real
autoplay blocking and interaction unlock, stall recovery, reload, logout/relogin and
terminal cleanup. Existing GUI and backend race suites also passed with the
audio runtime on PATH.

The final HTTPS run measured the expected 439.45 Hz/878.91 Hz FFT bins, 50.23
packets/s and no scheduling resets during its 60-second steady interval. Its
longest near-silent run was one sample (0.021 ms), including the deliberate
80 ms rendering stall. Playback recovered after the separate 400 ms stall.
The insecure HTTP run measured both channels and 50.2 packets/s. Both ended with
zero remaining audio processes. A separate isolated UID 0 probe also captured
46,057 active stereo frames, checking PulseAudio's root-user path used by the
default container login without changing the host root account or audio setup.

For PipeWire's comparison, the stripped build used Meson `--buildtype=minsize`,
`-Dauto_features=disabled -Ddbus=disabled -Dsession-managers=[]`, enabled
`spa-plugins`, `audioconvert`, `audiomixer`, `support`, LTO and stripping. The
3.19 MB subset contains its server, core library, Pulse/native protocol modules,
node factories, adapter/link/metadata/access modules and SPA support/audioconvert.
It was already larger than the complete PulseAudio candidate before adding a
capture client or proving routing.

## Remaining validation

Docker is unavailable in the agent environment. The user built the arm64 Docker
image and confirmed YouTube audio from container Chromium reached host Brave
with the initial sound-button UI. The agent tests measure Chromium’s rendered
output. Final Docker layer sizes, amd64 compilation, Safari/iOS and WAN lip-sync
remain unverified; the updated default-on/menu UI still needs a rebuilt container. Microphone forwarding and Opus compression
are outside this experiment. Source-built libraries require explicit version
maintenance; Debian package upgrades do not update these private copies.
