if (( ${+TUXEE_ZDOTDIR} )); then ZDOTDIR=$TUXEE_ZDOTDIR; else unset ZDOTDIR; fi
[[ ! -r ${ZDOTDIR-$HOME}/.zlogin ]] || source "${ZDOTDIR-$HOME}/.zlogin"
unset TUXEE_ZDOTDIR TUXEE_SHELL_DIR
