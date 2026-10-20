#!/bin/bash
set -em

stop() {
    trap '' INT TERM
    for pid in $(jobs -pr); do
        kill -TERM -- "-$pid" 2>/dev/null || true
    done
    wait
    exit 0
}
trap stop INT TERM

cd "$1"
for script in ./*.sh; do
    [ -f "$script" ] || continue
    printf 'Tuxee init: running %s\n' "$script"
    # Job control gives each script its own process group for shutdown.
    (
        # Wait for the foreground child to finish handling group shutdown.
        trap ':' INT TERM
        bash "$script" || printf 'Tuxee init: %s failed (exit %s); other scripts continue\n' "$script" "$?" >&2
    ) &
done
wait
