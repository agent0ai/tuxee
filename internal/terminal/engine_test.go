package terminal

import (
	"encoding/json"
	"strings"
	"testing"
)

func snapshotText(t *testing.T, data json.RawMessage, buffer string) string {
	t.Helper()
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(data, &snapshot); err != nil {
		t.Fatal(err)
	}
	var saved struct{ Lines []struct{ Data []uint32 } }
	if err := json.Unmarshal(snapshot[buffer], &saved); err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	for _, line := range saved.Lines {
		for i := 0; i < len(line.Data); i += 3 {
			if codepoint := line.Data[i] & 0x1fffff; codepoint != 0 {
				text.WriteRune(rune(codepoint))
			}
		}
		text.WriteByte('\n')
	}
	return text.String()
}

func TestCanonicalDisplay(t *testing.T) {
	e, err := NewEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, data := range [][]byte{[]byte("hello \xe2"), []byte("\x98\x83\r\n\x1b["), []byte("31mred\x1b[0m\x1b[6n")} {
		update, err := e.Apply(data, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "6n") && string(update.Reply) != "\x1b[2;4R" {
			t.Fatalf("query response %q", update.Reply)
		}
	}
	snapshot, err := e.Capture()
	if err != nil || !json.Valid(snapshot) {
		t.Fatalf("capture: %v", err)
	}
	display := snapshotText(t, snapshot, "normal")
	if !strings.Contains(display, "hello") || !strings.Contains(display, "☃") || !strings.Contains(display, "red") {
		t.Fatalf("snapshot missing content: %q", display)
	}
	if strings.Contains(display, "\x1b[6n") {
		t.Fatal("snapshot included an application query")
	}
	if _, err := e.Apply([]byte("\x1b[?1049h\x1b[Hfull screen"), 0, 0); err != nil {
		t.Fatal(err)
	}
	snapshot, err = e.Capture()
	if err != nil || !strings.Contains(snapshotText(t, snapshot, "alternate"), "full screen") {
		t.Fatalf("alternate screen: %v", err)
	}
}

func TestSynchronizedFrames(t *testing.T) {
	e, err := NewEngine(40, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	update, err := e.Apply([]byte("\x1b[?2026h\x1b[HONE\x1b[?2026l\x1b[?2026h\x1b[HTWO"), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !update.Synchronized {
		t.Fatal("synchronized output mode was lost")
	}
	update, err = e.Flush()
	if err != nil {
		t.Fatal(err)
	}
	if update.Synchronized {
		t.Fatal("deadline did not end synchronized output")
	}
	snapshot, err := e.Capture()
	if err != nil || !strings.Contains(snapshotText(t, snapshot, "normal"), "TWO") {
		t.Fatalf("flush lost final frame: %v", err)
	}
}
