#!/bin/bash
set -m

if [ "$#" -lt 2 ]; then
    printf 'Usage: %s INIT_DIRECTORY COMMAND [ARG...]\n' "$0" >&2
    exit 2
fi

runtime_dir=$(dirname "$0")
tuxee_root_password=${ROOT_PASSWORD-toor}
unset ROOT_PASSWORD
if [ ! -e "$runtime_dir/.root-password-initialized" ]; then
    if [[ -z "$tuxee_root_password" || "$tuxee_root_password" == *$'\n'* || "$tuxee_root_password" == *$'\r'* ]]; then
        printf 'ROOT_PASSWORD must be nonempty and contain no line breaks\n' >&2
        exit 1
    fi
    printf 'root:%s\n' "$tuxee_root_password" | chpasswd || exit 1
    touch "$runtime_dir/.root-password-initialized" || exit 1
fi
unset tuxee_root_password

stop() {
    trap '' INT TERM
    for pid in $(jobs -pr); do
        kill -TERM -- "-$pid" 2>/dev/null || true
    done
    wait
    exit 0
}
trap stop INT TERM

bash "$runtime_dir/docker-init.sh" "$1" &
shift

while true; do
    "$@" &
    wait "$!"
    printf 'Tuxee exited (status %s); restarting in 1 second\n' "$?" >&2
    sleep 1 &
    wait "$!"
done
