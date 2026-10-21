set -eu
umask 077
runtime=$1
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
dbus-daemon --session --address="unix:path=$runtime/bus" --nofork --print-address=3 3>"$runtime/ready" >&2 &
IFS= read -r bus < "$runtime/ready"
matchbox-window-manager -use_titlebar no >&2 &
printf 'ready\n'
wait "$vnc"
