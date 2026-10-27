# Zsh expands variable values as data; escape percent prompt sequences too.
setopt prompt_subst
_tuxee_prompt() {
    local exit_status=$? branch environment prefix='' separator=' '
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
        prefix=$'\n' separator=$'\n'
    fi
    _tuxee_prompt_path=${_tuxee_prompt_path//\%/%%}
    _tuxee_prompt_environment=${_tuxee_prompt_environment//\%/%%}
    _tuxee_prompt_branch=${_tuxee_prompt_branch//\%/%%}
    if [[ ${TERM:-dumb} == dumb || -n ${NO_COLOR:-} ]]; then
        PROMPT="$prefix"'${_tuxee_prompt_path}${_tuxee_prompt_environment}${_tuxee_prompt_branch}'"$separator"'❯ '
    else
        PROMPT="$prefix"'%B%F{#36cfa7}${_tuxee_prompt_path}%F{#fdbc03}${_tuxee_prompt_environment}%F{#ad94f7}${_tuxee_prompt_branch}%f'"$separator"'❯ %b'
    fi
    return $exit_status
}
typeset -ga precmd_functions
precmd_functions=(${precmd_functions:#_tuxee_prompt} _tuxee_prompt)
VIRTUAL_ENV_DISABLE_PROMPT=1
export CONDA_CHANGEPS1=false
RPROMPT=''
