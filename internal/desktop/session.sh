set -eu
umask 077
runtime=$1
audio=$2
IFS= read -r password
printf '%s\n' "$password" | tuxee-vncpasswd -f > "$runtime/passwd"
unset password
mkfifo "$runtime/ready"
tuxee-Xvnc "$DISPLAY" -geometry 1024x768 -depth 24 -displayfd 3 \
    -rfbport -1 -rfbunixpath "$runtime/vnc" -rfbunixmode 0600 \
    -SecurityTypes VncAuth -PasswordFile "$runtime/passwd" \
    -AlwaysShared -DisconnectClients=0 -auth "$XAUTHORITY" \
    -extension MIT-SHM -nolisten tcp -fp built-ins -s 0 3>"$runtime/ready" >&2 &
vnc=$!
trap 'kill "$vnc" 2>/dev/null || true; wait' EXIT
trap 'exit 0' TERM INT HUP
IFS= read -r display < "$runtime/ready"
if [ -n "$audio" ]; then
    mkdir -p "$runtime/pulse"
    cat > "$runtime/pulse/default.pa" <<EOF
load-module module-null-sink sink_name=tuxee format=s16le channels=2 rate=48000
set-default-sink tuxee
set-default-source tuxee.monitor
load-module module-native-protocol-unix socket=$runtime/pulse/native auth-cookie=$runtime/pulse/cookie
EOF
    PULSE_RUNTIME_PATH="$runtime/pulse" PULSE_STATE_PATH="$runtime/pulse" \
        "$audio" --daemonize=no --exit-idle-time=-1 --use-pid-file=no --disable-shm \
        --high-priority=no --realtime=no --resample-method=ffmpeg -n -F "$runtime/pulse/default.pa" >&2 &
    pulse=$!
    attempts=0
    while [ ! -S "$runtime/pulse/native" ]; do
        kill -0 "$pulse" 2>/dev/null || exit 1
        attempts=$((attempts + 1))
        [ "$attempts" -lt 100 ] || exit 1
        sleep 0.02
    done
fi
dbus-daemon --session --address="unix:path=$runtime/bus" --nofork --print-address=3 3>"$runtime/ready" >&2 &
IFS= read -r bus < "$runtime/ready"
matchbox-window-manager -use_titlebar no >&2 &
printf 'ready\n'
wait "$vnc"
