if (( ${+TUXEE_ZDOTDIR} )); then ZDOTDIR=$TUXEE_ZDOTDIR; else unset ZDOTDIR; fi
[[ ! -r ${ZDOTDIR-$HOME}/.zshrc ]] || source "${ZDOTDIR-$HOME}/.zshrc"
source "$TUXEE_SHELL_DIR/prompt.zsh"
unset TUXEE_ZDOTDIR TUXEE_SHELL_DIR
