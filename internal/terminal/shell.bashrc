# Keep login environment/aliases; apply the app prompt after user startup files.
[[ ! -r /etc/profile ]] || source /etc/profile
for _tuxee_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [[ -r $_tuxee_profile ]]; then source "$_tuxee_profile"; break; fi
done
unset _tuxee_profile _tuxee_prompt_ps1
source "$TUXEE_SHELL_DIR/prompt.bash"
unset TUXEE_SHELL_DIR
