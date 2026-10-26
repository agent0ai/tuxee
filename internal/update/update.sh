#!/bin/sh
# Cumulative container setup, embedded in the binary. Arguments: VERSION ARCH.
# Maintenance rules:
# - Describe the current required state, not a chain of historical upgrades.
#   Retain checks needed by supported older images so users can skip releases.
# - Add one idempotent ensure_* function per requirement and call it in main.
#   Check local state first; check component versions when requirements change.
# - Keep satisfied checks cheap and offline. Defer package queries, apt,
#   downloads and temporary files until a requirement is actually missing.
# - Return 0 for a satisfied requirement; never exit the whole script early.
#   Call ensure_* directly: wrapping calls in if/&&/|| disables set -e inside.
# - Use subshell functions (...) to isolate variables, cd and cleanup traps.
# - Refresh apt before installing missing packages. Bound HTTPS downloads,
#   verify checksums and probe staged files before installing them.
# - Let failures stop the script. setup.go marks success only after all checks,
#   skips fresh images/completed versions, limits runtime, and retries next start.
# - Extend tests/setup.py for ready, missing, partial and failed setup; preserve
#   the fresh-image skip and prove ready checks allow later steps to run.
set -eu
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Audio: private server and capture tool; leave Debian's audio stack untouched.
audio_ready() {
    /usr/local/bin/tuxee-pulseaudio --version >/dev/null 2>&1 &&
        /usr/local/bin/tuxee-pacat --version >/dev/null 2>&1
}

ensure_audio() (
    if audio_ready; then return 0; fi

    missing=''
    for package in ca-certificates curl tar gzip libcap2; do
        if [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]; then
            missing="$missing $package"
        fi
    done
    if [ -n "$missing" ]; then
        apt-get update -o APT::Update::Error-Mode=any
        # The list contains only the fixed package names above.
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -o DPkg::Lock::Timeout=60 $missing
        apt-get clean
        rm -rf /var/lib/apt/lists/*
    fi
    if audio_ready; then return 0; fi

    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    cd "$work"
    asset="tuxee-audio-linux-$arch.tar.gz"
    release="https://github.com/agent0ai/tuxee/releases/download/v$version"
    curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 \
        --max-filesize 1048576 "$release/checksums.txt" -o checksums.txt
    sum=$(awk -v asset="$asset" '$2 == asset { count++; sum = $1 }
        END { if (count != 1 || length(sum) != 64 || sum ~ /[^0-9a-fA-F]/) exit 1; print sum }' checksums.txt)
    curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 \
        --max-filesize 8388608 "$release/$asset" -o "$asset"
    printf '%s  %s\n' "$sum" "$asset" | sha256sum -c -
    mkdir stage
    tar -xzf "$asset" -C stage --no-same-owner
    stage/usr/local/bin/tuxee-pulseaudio --version
    stage/usr/local/bin/tuxee-pacat --version
    mkdir -p /usr/local/lib /usr/local/bin
    cp -a stage/usr/local/lib/tuxee-audio /usr/local/lib/
    install -m 0755 stage/usr/local/bin/tuxee-pulseaudio stage/usr/local/bin/tuxee-pacat /usr/local/bin/
    audio_ready
    echo 'Tuxee audio runtime installed'
)

ensure_bash_keys() (
    binding="bind '\"\\e[13;2u\": \"\\C-v\\C-j\"'"
    if grep -Fxq "$binding" /etc/bash.bashrc 2>/dev/null; then return 0; fi
    printf '\n%s\n' "$binding" >> /etc/bash.bashrc
)

ensure_root_prompt() (
    profile=/etc/profile.d/zz-tuxee-root.sh
    : "${TUXEE_ROOT_PROMPT:?missing embedded root prompt}"
    if [ -r "$profile" ] && [ "$(cat "$profile")" = "$TUXEE_ROOT_PROMPT" ]; then return 0; fi
    mkdir -p /etc/profile.d
    trap 'rm -f "$profile.tmp"' EXIT
    printf '%s\n' "$TUXEE_ROOT_PROMPT" > "$profile.tmp"
    chmod 0644 "$profile.tmp"
    mv -f "$profile.tmp" "$profile"
)

# Keep the complete list of requirements here, in dependency order.
main() {
    version=$1
    arch=$2
    printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || exit 1
    case "$arch" in amd64|arm64) ;; *) echo "Unsupported audio architecture: $arch" >&2; exit 1 ;; esac
    [ "$(id -u)" = 0 ] || { echo 'Container setup requires root' >&2; exit 1; }

    ensure_audio
    ensure_bash_keys
    ensure_root_prompt
}

main "$@"
