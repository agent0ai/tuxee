if (( ${+TUXEE_ZDOTDIR} )); then ZDOTDIR=$TUXEE_ZDOTDIR; else unset ZDOTDIR; fi
[[ ! -r ${ZDOTDIR-$HOME}/.zprofile ]] || source "${ZDOTDIR-$HOME}/.zprofile"
if [[ ! -o rcs ]]; then unset TUXEE_ZDOTDIR TUXEE_SHELL_DIR; return; fi
if (( ${+ZDOTDIR} )); then TUXEE_ZDOTDIR=$ZDOTDIR; else unset TUXEE_ZDOTDIR; fi
ZDOTDIR=$TUXEE_SHELL_DIR
