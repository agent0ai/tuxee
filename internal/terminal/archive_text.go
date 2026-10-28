package terminal

import (
	"strconv"
	"strings"
)

type archiveLine struct {
	Data     []uint32
	Length   int
	Combined map[string]string
}

// Pinned xterm cell encoding: content, foreground and background per cell.
func archiveText(lines []archiveLine) string {
	var text strings.Builder
	for i, line := range lines {
		if i > 0 {
			text.WriteByte('\n')
		}
		for x := 0; x < line.Length; {
			content := line.Data[x*3]
			if content&0x200000 != 0 {
				text.WriteString(line.Combined[strconv.Itoa(x)])
			} else if code := content & 0x1fffff; code != 0 {
				text.WriteRune(rune(code))
			} else {
				text.WriteByte(' ')
			}
			width := int(content >> 22)
			if width == 0 {
				width = 1
			}
			x += width
		}
	}
	return text.String()
}
