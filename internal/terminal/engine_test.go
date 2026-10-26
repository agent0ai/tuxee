package terminal

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dop251/goja"
)

func BenchmarkSnapshotCapture(b *testing.B) {
	for _, size := range []struct {
		name        string
		cols, lines int
	}{{"80x5000", 80, 5000}, {"240x2000", 240, 2000}} {
		b.Run(size.name, func(b *testing.B) {
			e, err := NewEngine(size.cols, 24)
			if err != nil {
				b.Fatal(err)
			}
			defer e.Close()
			block := bytes.Repeat([]byte(strings.Repeat("x", size.cols-1)+"\r\n"), 100)
			for i := 0; i < size.lines; i += 100 {
				if _, err := e.Apply(block, 0, 0); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := e.Capture(); err != nil {
					b.Fatal(err)
				}
			}
			b.StopTimer()
		})
	}
}

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

func TestTerminalBackground(t *testing.T) {
	e, err := NewEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	query := func(want string) {
		t.Helper()
		update, err := e.Apply([]byte("\x1b]11;?\x07"), 0, 0)
		if err != nil || string(update.Reply) != "\x1b]11;rgb:"+want+"\x1b\\" {
			t.Fatalf("background query: %q, %v", update.Reply, err)
		}
	}
	query("1414/1919/2222")
	if _, err := e.Apply([]byte("\x1b]4;2;#112233\x07\x1b]10;#abcdef\x07\x1b]2;partial"), 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := e.SetBackground("#123456"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Apply([]byte(" title\x07unchanged"), 0, 0); err != nil {
		t.Fatal(err)
	}
	query("1212/3434/5656")
	snapshot, err := e.Capture()
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		Palette struct{ Colors, Defaults []uint32 }
	}
	if err := json.Unmarshal(snapshot, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Palette.Colors[257] != 0x123456ff || saved.Palette.Defaults[257] != 0x123456ff ||
		saved.Palette.Colors[2] != 0x112233ff || saved.Palette.Colors[256] != 0xabcdefff ||
		!strings.Contains(snapshotText(t, snapshot, "normal"), "unchanged") {
		t.Fatal("background update lost palette or parser state")
	}
	if _, err := e.Apply([]byte("\x1b]11;#ffffff\x07\x1b]111\x07"), 0, 0); err != nil {
		t.Fatal(err)
	}
	query("1212/3434/5656")
	if err := e.SetBackground("red"); err == nil {
		t.Fatal("accepted invalid background")
	}
	query("1212/3434/5656")
	if err := e.SetBackground(""); err != nil {
		t.Fatal(err)
	}
	query("1414/1919/2222")
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

func TestEmojiColumnWidths(t *testing.T) {
	e, err := NewEngine(96, 25)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, emoji := range []string{"👋", "👍"} {
		update, err := e.Apply([]byte("\r"+emoji+"A\x1b[6n"), 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if string(update.Reply) != "\x1b[1;4R" {
			t.Fatalf("%s must occupy two columns; cursor reply %q", emoji, update.Reply)
		}
	}
}

func TestSnapshotSerializedByteLimit(t *testing.T) {
	e, err := NewEngine(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ready := make(chan error, 1)
	e.loop.RunOnLoop(func(vm *goja.Runtime) {
		ready <- vm.Set("tuxeeEngine", map[string]any{"capture": func() string { return strings.Repeat(" ", MaxSnapshotBytes+1) }, "close": func() {}})
	})
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	if data, err := e.Capture(); err == nil || data != nil {
		t.Fatal("oversized serialized snapshot was admitted")
	}
}
