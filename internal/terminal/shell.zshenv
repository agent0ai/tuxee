if (( ${+TUXEE_ZDOTDIR} )); then ZDOTDIR=$TUXEE_ZDOTDIR; else unset ZDOTDIR; fi
[[ ! -r ${ZDOTDIR-$HOME}/.zshenv ]] || source "${ZDOTDIR-$HOME}/.zshenv"
if [[ ! -o rcs ]]; then unset TUXEE_ZDOTDIR TUXEE_SHELL_DIR; return; fi
if (( ${+ZDOTDIR} )); then TUXEE_ZDOTDIR=$ZDOTDIR; else unset TUXEE_ZDOTDIR; fi
ZDOTDIR=$TUXEE_SHELL_DIR
