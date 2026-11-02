#!/bin/bash
set -m
set -o pipefail

if [ "$#" -lt 2 ]; then
    printf 'Usage: %s INIT_DIRECTORY COMMAND [ARG...]\n' "$0" >&2
    exit 2
fi

runtime_dir=$(dirname "$0")
tuxee_root_password=${ROOT_PASSWORD:-}
tuxee_root_password_file=${ROOT_PASSWORD_FILE:-}
unset ROOT_PASSWORD ROOT_PASSWORD_FILE
if [ ! -e "$runtime_dir/.root-password-initialized" ]; then
    tuxee_generated_password=false
    if [[ -n "$tuxee_root_password_file" ]]; then
        if [[ -n "$tuxee_root_password" ]]; then
            printf 'Set only one of ROOT_PASSWORD and ROOT_PASSWORD_FILE\n' >&2
            exit 1
        fi
        if [[ ! -f "$tuxee_root_password_file" || ! -r "$tuxee_root_password_file" ]]; then
            printf 'ROOT_PASSWORD_FILE must point to a readable file\n' >&2
            exit 1
        fi
        tuxee_root_password=$(cat -- "$tuxee_root_password_file") || exit 1
    elif [[ -z "$tuxee_root_password" ]]; then
        tuxee_root_password=$(head -c 24 /dev/urandom | base64) || exit 1
        [[ ${#tuxee_root_password} -eq 32 ]] || exit 1
        tuxee_generated_password=true
    fi
    if [[ -z "$tuxee_root_password" || "$tuxee_root_password" == *$'\n'* || "$tuxee_root_password" == *$'\r'* ]]; then
        printf 'Root password must be nonempty and contain no line breaks\n' >&2
        exit 1
    fi
    printf 'root:%s\n' "$tuxee_root_password" | chpasswd || exit 1
    touch "$runtime_dir/.root-password-initialized" || exit 1
    if [[ "$tuxee_generated_password" == true ]]; then
        printf '\n\033[33mWARNING: No root password set. Generated root password: %s\nChange it immediately after your first login!\033[0m\n\n' "$tuxee_root_password" >&2
    fi
fi
unset tuxee_root_password tuxee_root_password_file tuxee_generated_password

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
