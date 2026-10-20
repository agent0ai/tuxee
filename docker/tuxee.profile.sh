# Prompt from the8020/kernel development image; user startup files may override it.
if [ -n "${BASH_VERSION:-}" ]; then
  case $- in
    *i*)
      case ${TERM:-dumb} in
        xterm*|rxvt*|screen*|tmux*|linux|vt100)
          PS1='\[\033[1;32m\]\u@\h\[\033[0m\]:\[\033[1;34m\]\w\[\033[0m\]\$ '
          ;;
      esac
      ;;
  esac
fi
