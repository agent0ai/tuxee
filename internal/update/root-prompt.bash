# Root's container login prompt; keep other users and non-Bash shells unchanged.
[ -n "${BASH_VERSION:-}" ] || return 0
[ "${EUID:-1}" = 0 ] || return 0
[[ $- == *i* ]] || return 0

_tuxee_prompt() {
    local status=$? branch environment prefix='' separator=' '
    # A user startup file or prompt manager can replace our default PS1.
    if [[ -n ${_tuxee_prompt_ps1:-} && $PS1 != "$_tuxee_prompt_ps1" ]]; then
        return "$status"
    fi
    _tuxee_prompt_path=$PWD
    case $PWD in
        "$HOME") _tuxee_prompt_path='~' ;;
        "$HOME"/*) _tuxee_prompt_path="~${PWD#"$HOME"}" ;;
    esac
    _tuxee_prompt_branch='' _tuxee_prompt_environment=''
    if branch=$(timeout .25s git symbolic-ref --quiet --short HEAD 2>/dev/null) ||
       branch=$(timeout .25s git rev-parse --short HEAD 2>/dev/null); then
        _tuxee_prompt_branch=" on $branch"
    fi
    environment=${VIRTUAL_ENV:-${CONDA_PREFIX:-}}
    if [[ -n $environment ]]; then
        environment=${environment%/}
        _tuxee_prompt_environment=" in ${environment##*/}"
    fi
    _tuxee_prompt_path=${_tuxee_prompt_path//[[:cntrl:]]/?}
    _tuxee_prompt_branch=${_tuxee_prompt_branch//[[:cntrl:]]/?}
    _tuxee_prompt_environment=${_tuxee_prompt_environment//[[:cntrl:]]/?}
    if (( ${#_tuxee_prompt_path} + ${#_tuxee_prompt_environment} + ${#_tuxee_prompt_branch} + 3 >= 25 )); then
        prefix='\n' separator='\n'
    fi
    # Expand data as variables so names cannot inject prompt commands or escapes.
    if [[ ${TERM:-dumb} == dumb || -n ${NO_COLOR:-} ]]; then
        PS1="$prefix"'${_tuxee_prompt_path}${_tuxee_prompt_environment}${_tuxee_prompt_branch}'"$separator"'❯ '
    else
        PS1="$prefix"'\[\e[0;1;38;2;54;207;167m\]${_tuxee_prompt_path}\[\e[38;2;253;188;3m\]${_tuxee_prompt_environment}\[\e[38;2;173;148;247m\]${_tuxee_prompt_branch}\[\e[39m\]'"$separator"'❯ \[\e[0m\]'
    fi
    _tuxee_prompt_ps1=$PS1
    return "$status"
}

for _tuxee_hook in "${PROMPT_COMMAND[@]}"; do
    [[ $_tuxee_hook == _tuxee_prompt ]] && { unset _tuxee_hook; return 0; }
done
unset _tuxee_hook
# The prompt already shows the active environment; avoid duplicate prefixes.
VIRTUAL_ENV_DISABLE_PROMPT=1
export CONDA_CHANGEPS1=false
_tuxee_prompt
PROMPT_COMMAND+=(_tuxee_prompt)
