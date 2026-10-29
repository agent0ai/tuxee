package server

import (
	"regexp"
	"strings"

	"tuxee/internal/i18n"
)

var shortcutAction = regexp.MustCompile(`^(desktop\.(previous|next|add|[1-9]|10)|panel\.(next|previous|terminal|files|close|layout)|audio\.(mute|up|down)|app\.(monitor|about|settings|retained|shortcuts|restart|logout))$`)
var shortcutKey = regexp.MustCompile(`^(Control\+)?(Alt\+)?(Shift\+)?(Meta\+)?(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Left|Right|Up|Down)|Space|Tab|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Insert|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$`)
var shortcutStart = regexp.MustCompile(`^(Control\+|Alt\+|(Shift\+)?Meta\+|F([1-9]|1[0-2])$)`)

func validateShortcuts(value map[string][][]string) error {
	invalid := func() error { return i18n.New("shortcuts.invalid") }
	if len(value) > 29 {
		return invalid()
	}
	var sequences []string
	for action, slots := range value {
		if !shortcutAction.MatchString(action) || len(slots) != 2 {
			return invalid()
		}
		for _, sequence := range slots {
			if sequence == nil || len(sequence) > 3 {
				return invalid()
			}
			for i, stroke := range sequence {
				if len(stroke) > 64 || !shortcutKey.MatchString(stroke) || i == 0 && !shortcutStart.MatchString(stroke) {
					return invalid()
				}
			}
			if len(sequence) == 0 {
				continue
			}
			joined := strings.Join(sequence, " ") + " "
			for _, previous := range sequences {
				if strings.HasPrefix(joined, previous) || strings.HasPrefix(previous, joined) {
					return invalid()
				}
			}
			sequences = append(sequences, joined)
		}
	}
	return nil
}
