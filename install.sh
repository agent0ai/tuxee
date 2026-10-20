#!/bin/sh
# curl -fsSL https://tuxee.agent-zero.ai/install.sh | sudo sh -s -- [v1.2.3]
set -eu

main() {
    if [ "$#" -gt 1 ]; then
        echo 'Usage: install.sh [vMAJOR.MINOR.PATCH]' >&2
        exit 2
    fi
    case "${1:-}" in --help|-h) echo 'Usage: install.sh [vMAJOR.MINOR.PATCH]'; return ;; esac
    [ "$(id -u)" = 0 ] || { echo 'Run with sudo sh, or as root.' >&2; exit 1; }
    [ "$(uname -s)" = Linux ] || { echo 'Tuxee requires Linux.' >&2; exit 1; }
    case "$(uname -m)" in
        x86_64|amd64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) echo 'Supported architectures: x86-64 and ARM64.' >&2; exit 1 ;;
    esac
    for tool in curl sha256sum mktemp awk; do
        command -v "$tool" >/dev/null 2>&1 || { echo "Required command missing: $tool" >&2; exit 1; }
    done
    stage=$(mktemp -d "${TMPDIR:-/tmp}/tuxee-install.XXXXXXXX")
    trap 'rm -rf "$stage"' 0
    trap 'exit 1' HUP INT TERM
    tag=${1:-}
    if [ -z "$tag" ]; then
        latest=$(curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 30 --max-redirs 5 \
            -o /dev/null -w '%{url_effective}' https://github.com/agent0ai/tuxee/releases/latest)
        tag=${latest##*/}
    fi
    tag=v${tag#v}
    printf '%s\n' "$tag" | awk '/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ { ok=1 } END { exit !ok }' ||
        { echo 'Expected a stable version such as v1.2.3.' >&2; exit 1; }
    base=https://github.com/agent0ai/tuxee/releases/download/$tag
    name=tuxee-linux-$arch
    echo "Downloading Tuxee $tag for Linux/$arch..."
    download "$base/checksums.txt" "$stage/checksums.txt" 1048576
    download "$base/$name" "$stage/$name" 134217728
    expected=$(awk -v name="$name" '$2 == name { if (NF != 2 || ++n > 1 || length($1) != 64 || $1 ~ /[^0-9a-fA-F]/) exit 1; hash=tolower($1) } END { if (n != 1) exit 1; print hash }' "$stage/checksums.txt")
    actual=$(sha256sum "$stage/$name" | awk '{print $1}')
    [ "$actual" = "$expected" ] || { echo 'Checksum mismatch; installation unchanged.' >&2; exit 1; }
    chmod 700 "$stage/$name"
    [ "$("$stage/$name" version)" = "Tuxee ${tag#v}" ] ||
        { echo 'Binary cannot run here. Check glibc/PAM compatibility; installation unchanged.' >&2; exit 1; }
    "$stage/$name" __install
}

download() (
    # Bound streamed bodies even when the server omits Content-Length.
    ulimit -f 262144
    curl -fSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --max-redirs 5 \
        --max-filesize "$3" -o "$2" "$1"
    [ "$(wc -c < "$2")" -le "$3" ]
)

# Parse the complete script before doing work when piped into sh.
main "$@"
