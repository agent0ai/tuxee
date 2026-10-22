# Shared terminal and GUI audio

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

The shared browser player adds no npm dependency or separate production asset.

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

All terminals belonging to one Linux user share a private PulseAudio server, Unix
socket and cookie. Shells receive the same stable `PULSE_SERVER` and `PULSE_COOKIE`
values. The first application audio connection starts the runtime; an ordinary
shell or listening browser alone starts no audio process. GUI and command-line
apps use the same mixer, independently of X11. Other Linux users remain isolated.
Applications must support PulseAudio; ALSA-only apps are not covered.

Audio starts at 100% on each page load. The speaker to the right of the theme switcher
controls the single mixed stream in that browser, including terminals outside mounted workspaces.
It opens a vertical 0–100% slider in 1% steps with Mute/Unmute at the bottom,
in a popup four times the navigation bar's height. The header icon indicates
muted, low or high volume. The bottom button keeps its mute icon and highlights
only while muted. Unmute restores the last nonzero level. Volume changes apply live
through one Web Audio gain node; they do not change applications or other listeners.
GUI window menus contain only Close. Volume survives header/theme/workspace
changes and runtime relaunch within the page, without a persisted setting.

If the browser blocks autoplay, a normal click or keypress in Tuxee unlocks
playback; capture starts only after playback is allowed (see
[browser autoplay policy](https://developer.chrome.com/blog/autoplay#web-audio)).
Mute or zero volume closes that browser's audio connection. One capture process
feeds all listening browsers for the user; the last listener leaving stops capture.
Reload/logout disconnect that browser while preserving applications and PulseAudio.
Workspace switches and GUI closure do not affect audio. Ending the last terminal
stops the user's audio runtime; a later terminal can start it lazily again.

Transport is 48 kHz, stereo, signed 16-bit little-endian PCM in 20 ms packets,
with an 8-byte little-endian sample position: **192,400 bytes/s, or 1.5392 Mbit/s**
per browser during continuous audio, before WebSocket/TLS overhead. Completely
zero PCM packets are omitted; capture and the browser connection remain ready.
Sample positions preserve pauses, and no volume threshold discards quiet samples
or fades. Capture becomes ready before forwarding the first app connection. The
virtual sink disables rewinds so monitor capture retains the initial samples.
Idle connections send only occasional WebSocket keepalives. This minimizes
installed code at the cost of bandwidth. There is no codec or decoding dependency.
Playback uses native AudioBufferSourceNodes and also works on insecure HTTP
origins. It initially buffers 120 ms, caps the queue at 200 ms and recovers after
a stalled main thread. A stall longer than the queued audio can cause a gap.
Audio and VNC have independent clocks; this is not an audiovisual synchronization
protocol. WAN lip-sync and sustained congested links need separate validation.

The shared-runtime Chromium check measured about 5.7 MiB combined RSS for one
PulseAudio server and one capture process while GUI and terminal-only apps
played together. This is a process snapshot, not peak memory or a controlled
CPU comparison; application and browser memory are additional.

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
  GOMAXPROCS=2 .tools/go/bin/go test -race -p 2 ./internal/audio ./internal/desktop ./internal/terminal ./internal/server
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
and failure diagnostics. Both protocols verify terminal-only playback before any
GUI, 4,800 initial samples and 4,800 samples at the quietest nonzero PCM level,
a preserved 1.3-second gap, and zero audio packets during a silent observation.
Real remote Chromium supplies 44.1 kHz stereo 440/880 Hz tones; the browser
measures the converted 48 kHz output. A second command-line player mixes through
the same PulseAudio, capture and browser context. Header controls, mute/zero,
unmute volume restoration, autoplay, reload/logout, GUI closure and final
terminal cleanup are exercised. Tests run a private copy of the executable.

The HTTPS run measured 50.25 packets/s during its 60-second steady
interval, with a longest near-zero run of 0.021 ms, including the
80 ms rendering stall. Playback recovered after a separate 400 ms stall; the
largest scheduled lead was 160 ms. The insecure HTTP run measured
50.30 packets/s. Both ended with zero audio processes. Backend race tests
cover exact stereo/onset/quiet samples, user isolation, protected socket paths,
shared capture, slow listeners, independent unsubscribe, cleanup and lazy
relaunch, including UID 0 with a temporary home and no host account changes.

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
remain unverified; the shared audio runtime still needs a rebuilt container. Microphone forwarding and Opus compression
are outside this experiment. Source-built libraries require explicit version
maintenance; Debian package upgrades do not update these private copies.
