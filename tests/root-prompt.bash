#!/usr/bin/env bash
set -eu
prompt_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../internal/update" && pwd)
if [[ ${1:-} != --interactive ]]; then
    bash --noprofile --norc -c 'PS1=original; source "$1/root-prompt.bash"; [[ $PS1 == original ]] && ! declare -F _tuxee_prompt' _ "$prompt_directory"
    sh -c 'PS1=original; . "$1/root-prompt.bash"; [ "$PS1" = original ]' _ "$prompt_directory"
    if [[ $EUID != 0 ]]; then echo 'SKIP: root prompt fixtures require root'; exit 0; fi
    nonroot_profile=$(mktemp /tmp/tuxee-root-prompt.XXXXXX)
    trap 'rm -f -- "$nonroot_profile"' EXIT
    cp "$prompt_directory/root-prompt.bash" "$nonroot_profile"
    chmod 0644 "$nonroot_profile"
    setpriv --reuid=65534 --regid=65534 --clear-groups bash --noprofile --norc -ic 'PS1=original; source "$1"; [[ $PS1 == original ]] && ! declare -F _tuxee_prompt' _ "$nonroot_profile"
    rm -- "$nonroot_profile"
    trap - EXIT
    exec bash --noprofile --norc -ic 'source "$1" --interactive' _ "${BASH_SOURCE[0]}"
fi
fixture=$(mktemp -d /tmp/tuxee.XXXXXX)
trap 'rm -rf -- "$fixture"' EXIT
unset VIRTUAL_ENV CONDA_PREFIX CONDA_DEFAULT_ENV NO_COLOR
PROMPT_COMMAND=': existing-hook'
source "$prompt_directory/root-prompt.bash"
source "$prompt_directory/root-prompt.bash"
[[ ${#PROMPT_COMMAND[@]} == 2 && ${PROMPT_COMMAND[0]} == ': existing-hook' && ${PROMPT_COMMAND[1]} == _tuxee_prompt ]]
PROMPT_COMMAND=(': first-hook' ': second-hook')
source "$prompt_directory/root-prompt.bash"
[[ ${#PROMPT_COMMAND[@]} == 3 && ${PROMPT_COMMAND[1]} == ': second-hook' ]]
render() { _tuxee_prompt; printf -v rendered '%s' "${PS1@P}"; rendered=${rendered//[$'\r\001\002']/}; }
commit() { git -c user.name='Jan Tomášek' -c user.email='tomasekhonza@gmail.com' commit --quiet --allow-empty -m "${1:-Prompt fixture}"; }
cd "$fixture"
NO_COLOR=1 render
[[ $rendered == "$fixture ❯ " && -z $_tuxee_prompt_environment && -z $_tuxee_prompt_branch ]]
mkdir .venv
render; [[ -z $_tuxee_prompt_environment ]]
git init --quiet --initial-branch=main
render; [[ $_tuxee_prompt_branch == ' on main' ]]
commit
render; [[ $_tuxee_prompt_branch == ' on main' ]]
git tag v0.1.0
NO_COLOR=1 render
[[ $rendered == $'\n'"$fixture on main"$'\n❯ ' ]]
commit
render; [[ $_tuxee_prompt_branch == ' on main' ]]
git checkout --quiet --detach
render; [[ $_tuxee_prompt_branch == " on $(git rev-parse --short HEAD)" ]]
git checkout --quiet main
mkdir -p folder/sub
cd folder/sub
python3 -m venv --without-pip "$fixture/venv"
source "$fixture/venv/bin/activate"
NO_COLOR=1 render
[[ $rendered == $'\n'"$fixture/folder/sub in venv on main"$'\n❯ ' ]]
deactivate
render; [[ -z $_tuxee_prompt_environment ]]
touch pyproject.toml package.json go.mod Cargo.toml
mkdir "$fixture/probes"
for executable in python python3 node go rustc; do
    printf '#!/bin/sh\nprintf called >> "$TUXEE_PROMPT_PROBE_FILE"\n' > "$fixture/probes/$executable"
    chmod +x "$fixture/probes/$executable"
done
PATH="$fixture/probes:$PATH" TUXEE_PROMPT_PROBE_FILE="$fixture/probed" render
[[ ! -e $fixture/probed && $rendered != *' via '* ]]
git init --quiet --initial-branch=nested
render; [[ $_tuxee_prompt_branch == ' on nested' ]]
cd "$HOME"
render; [[ $_tuxee_prompt_path == '~' ]]
NO_COLOR=1 render; [[ $rendered != *$'\e'* ]]
TERM=dumb render; [[ $rendered != *$'\e'* ]]
TERM=xterm-256color render
[[ $rendered == $'\e[0;1;38;2;54;207;167m'* && $rendered == *$'\e[39m ❯ \e[0m' && $rendered != *$'\n'* ]]
for environment in 1234567890123456 12345678901234567 123456789012345678 é234567890123456; do
    prefix=$'\n' separator=$'\n'
    [[ ${#environment} != 16 ]] || { prefix=''; separator=' '; }
    expected="${prefix}~ in $environment${separator}❯ "
    VIRTUAL_ENV="/tmp/$environment" NO_COLOR=1 render
    [[ $rendered == "$expected" ]]
    VIRTUAL_ENV="/tmp/$environment" TERM=dumb render
    [[ $rendered == "$expected" ]]
    VIRTUAL_ENV="/tmp/$environment" TERM=xterm-256color render
    [[ $rendered == "$prefix"$'\e[0;1;38;2;54;207;167m~\e[38;2;253;188;3m in '"$environment"$'\e[38;2;173;148;247m\e[39m'"$separator"$'❯ \e[0m' ]]
done
NO_COLOR=1 render; [[ $rendered == '~ ❯ ' ]]
cd "$fixture"
mkdir '$(touch PWN)'
cd '$(touch PWN)'
CONDA_PREFIX='/tmp/$(touch CONDA_PWN)' render
[[ $rendered == *'$(touch PWN)'* && $rendered == *'$(touch CONDA_PWN)'* && ! -e PWN && ! -e CONDA_PWN ]]
git checkout --quiet -b '$(touch${IFS}GIT_PWN)'
render
[[ $rendered == *'$(touch${IFS}GIT_PWN)'* && ! -e GIT_PWN ]]
mkdir $'line\n\e[31m'
cd $'line\n\e[31m'
render; [[ $_tuxee_prompt_path != *$'\e'* && $_tuxee_prompt_path != *$'\n'* ]]
if (false; _tuxee_prompt; [[ $? == 1 ]]); then :; else exit 1; fi
PS1='custom> '
render; [[ $rendered == 'custom> ' ]]
printf '%s\n' 'PASS: adaptive prompt, 24/25/26-character boundaries, Unicode/color/plain output, branch without tags or counts, detached HEAD, virtualenv, no runtime probes, hooks, status and unsafe names'
