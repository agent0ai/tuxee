# Interpret the saved command only after dropping to the terminal owner's UID.
umask 022
_tuxee_run_command=$2
TUXEE_SHELL_DIR=$3
export TUXEE_SHELL_DIR
_tuxee_shell() {
    SHELL=$(command -v "$1") || { printf 'Shell not found: %s\n' "$1" >&2; return 127; }
    export SHELL
    if [ -z "$TUXEE_SHELL_DIR" ]; then unset TUXEE_SHELL_DIR; exec "$@" -l; fi
    _tuxee_program=$1
    shift
    case ${_tuxee_program##*/} in
        bash)
            # Bash ignores --rcfile with --login; the rcfile loads login profiles.
            for _tuxee_arg do
                shift
                case $_tuxee_arg in
                    -l|--login) ;;
                    -il|-li) set -- "$@" -i ;;
                    *) set -- "$@" "$_tuxee_arg" ;;
                esac
            done
            exec "$_tuxee_program" --rcfile "$TUXEE_SHELL_DIR/shell.bashrc" "$@" -i
            ;;
        zsh)
            if [ "${ZDOTDIR+x}" ]; then export TUXEE_ZDOTDIR=$ZDOTDIR; else unset TUXEE_ZDOTDIR; fi
            export ZDOTDIR=$TUXEE_SHELL_DIR
            exec "$_tuxee_program" "$@" -l
            ;;
        fish) exec "$_tuxee_program" "$@" -l --init-command 'source "$TUXEE_SHELL_DIR/shell.fish"' ;;
        *)
            if [ -n "$_tuxee_run_command" ]; then
                export TUXEE_ENV=${ENV-} ENV=$TUXEE_SHELL_DIR/shell.env
            else
                unset TUXEE_SHELL_DIR
            fi
            exec "$_tuxee_program" "$@" -il
            ;;
    esac
}
eval "_tuxee_shell $1"
