# Installation

Prebuilt binaries support Linux x86-64 (`amd64`) and ARM64 with glibc 2.36+,
PAM and the system's PAM/NSS configuration, including Debian 12+ and Ubuntu 24.04+.
They do not support Alpine/musl or 32-bit systems. Go and Node are not needed
to run them. For the container, see [Docker setup](guide.md#docker).

## Install script

Install or update to the latest stable release:

```sh
curl -fsSL https://tuxee.agent-zero.ai/install.sh | sudo sh
```

Or select a version:

```sh
curl -fsSL https://tuxee.agent-zero.ai/install.sh | sudo sh -s -- v1.2.3
```

Omit `sudo` when already root. The installer needs curl and sha256sum.
It verifies the download and installs `tuxee` in `/usr/local/bin` without
starting or restarting it. If that directory is missing from your PATH, run:

```sh
export PATH="/usr/local/bin:$PATH"
```

Add that line to your shell profile if needed.

### Update an older installation

Rerun the same install command, even if the installed version has no
`tuxee update` command. The script runs the downloaded binary's installer.
It replaces an existing Tuxee binary at `/usr/local/lib/tuxee/tuxee` (the default
systemd service location) or `/usr/local/bin/tuxee`, preserving configuration,
state and the service unit. Repeating the command is safe; unrelated files
are refused.

The running server keeps its old version until restarted. When ready, restart
the default service:

```sh
sudo /usr/local/bin/tuxee restart
```

Restarting ends all terminal sessions. For a foreground server, stop it and run
`/usr/local/bin/tuxee serve` with its original options. Custom executable paths
and custom-named service copies are separate installations; this command updates
only the default installation.

## Manual binary installation

Download the binary and checksum from the same
[GitHub release](https://github.com/agent0ai/tuxee/releases). These commands
select the latest release; replace the `tag=...` line with `tag=v1.2.3` to choose
a specific version.

```sh
(
    set -eu
    case "$(uname -m)" in
        x86_64|amd64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) echo "Supported architectures: x86-64 and ARM64." >&2; exit 1 ;;
    esac
    release=$(curl -fsSL --proto '=https' --proto-redir '=https' \
        --connect-timeout 10 --max-time 30 -o /dev/null -w '%{url_effective}' \
        https://github.com/agent0ai/tuxee/releases/latest)
    tag=${release##*/}
    asset=tuxee-linux-$arch
    base=https://github.com/agent0ai/tuxee/releases/download/$tag
    stage=$(mktemp -d)
    trap 'rm -rf "$stage"' EXIT
    cd "$stage"
    curl -fSL --proto '=https' --proto-redir '=https' --connect-timeout 10 \
        --max-time 120 --max-filesize 134217728 -o "$asset" "$base/$asset"
    curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 \
        --max-time 30 --max-filesize 1048576 -o checksums.txt "$base/checksums.txt"
    awk -v name="$asset" '$2 == name' checksums.txt > selected-checksum.txt
    sha256sum --check --strict selected-checksum.txt
    chmod 700 "$asset"
    [ "$("./$asset" version)" = "Tuxee ${tag#v}" ]
    sudo "./$asset" __install
)
```

The final command invokes the binary's installer. It safely replaces an existing
Tuxee executable, preserves configuration, and refuses unrelated commands at the
installation path. Installation uses `/usr/local/lib/tuxee/tuxee` with a symlink
at `/usr/local/bin/tuxee`. Neither installation method restarts a running server.

## Run

```sh
sudo tuxee serve
```

Open `https://SERVER/` and sign in with an existing Linux username and password.
Private addresses use a local certificate; see [HTTPS setup](guide.md#https).
Root is required to authenticate Linux users and run their shells with their
own permissions.

On a system with a running systemd manager, register boot startup and start:

```sh
sudo tuxee service install
sudo tuxee start
```

Other systems can run `tuxee serve` through their existing supervisor.
See [service management](guide.md#native-service) and [updates](releases.md#update).
Restarting Tuxee ends its terminal sessions.

## Advanced: build from source

Requires Linux, Go 1.26.3+, Node 22+, a C compiler and PAM development headers.
On Debian/Ubuntu, install the native build dependencies:

```sh
sudo apt-get update
sudo apt-get install git build-essential libpam0g-dev
```

With Go and Node on PATH:

```sh
git clone https://github.com/agent0ai/tuxee.git
cd tuxee
npm ci
npm run build
go build -trimpath -o bin/tuxee ./cmd/tuxee
sudo ./bin/tuxee serve
```

Build the frontend before Go builds or tests on a fresh checkout. The result
includes the web UI; Node is not required at runtime. The executable links to
the build system's glibc and PAM, so build on a compatible system.

To install the source build as a boot service:

```sh
sudo ./bin/tuxee service install
sudo ./bin/tuxee start
```

See the [developer guide](guide.md#build-and-run) for isolated local runs and
[verification commands](guide.md#verification).
