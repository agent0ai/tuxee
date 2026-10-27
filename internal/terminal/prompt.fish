# Fish's standard prompt hook; no packages or external prompt engine.
function fish_prompt
    set -l exit_status $status
    set -l path $PWD
    if test "$PWD" = "$HOME"
        set path '~'
    else if test (string sub -l (string length -- "$HOME/") -- "$PWD") = "$HOME/"
        set path '~'(string sub -s (math (string length -- "$HOME") + 1) -- "$PWD")
    end
    set -l branch (timeout .25s git symbolic-ref --quiet --short HEAD 2>/dev/null)
    or set branch (timeout .25s git rev-parse --short HEAD 2>/dev/null)
    if test -n "$branch"
        set branch " on $branch"
    end
    set -l environment "$VIRTUAL_ENV"
    if test -z "$environment"
        set environment "$CONDA_PREFIX"
    end
    if test -n "$environment"
        set environment ' in '(string replace -r '.*/' '' -- (string trim -r -c / -- "$environment"))
    end
    set path (string replace -ar '[[:cntrl:]]' '?' -- "$path")
    set branch (string replace -ar '[[:cntrl:]]' '?' -- "$branch")
    set environment (string replace -ar '[[:cntrl:]]' '?' -- "$environment")
    set -l separator ' '
    if test (string length -- "$path$environment$branch ❯ ") -ge 25
        printf '\n'
        set separator \n
    end
    set -l colors '' '' '' '' ''
    if test "$TERM" != dumb; and test -z "$NO_COLOR"
        set colors (set_color --bold 36cfa7) (set_color fdbc03) (set_color ad94f7) (set_color normal)(set_color --bold) (set_color normal)
    end
    printf '%s%s%s%s%s%s%s%s❯ %s' "$colors[1]" "$path" "$colors[2]" "$environment" "$colors[3]" "$branch" "$colors[4]" "$separator" "$colors[5]"
    return $exit_status
end
function fish_right_prompt
end
set -g VIRTUAL_ENV_DISABLE_PROMPT 1
set -gx CONDA_CHANGEPS1 false
