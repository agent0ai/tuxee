package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"github.com/jezek/xgb/xproto"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
	"time"
)

func clipboardPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 256, 256))
	var seed uint32 = 7
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			seed = seed*1664525 + 1013904223
			img.SetNRGBA(x, y, color.NRGBA{uint8(seed), uint8(seed >> 8), uint8(seed >> 16), 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestClipboardValidation(t *testing.T) {
	oversized := clipboardPNG(t)
	binary.BigEndian.PutUint32(oversized[16:20], 65537)
	binary.BigEndian.PutUint32(oversized[29:33], crc32.ChecksumIEEE(oversized[12:29]))
	if validateClipboard(ClipboardData{PNG: oversized}) == nil {
		t.Fatal("oversized decoded image accepted")
	}
	for _, data := range []ClipboardData{
		{Text: strings.Repeat("x", maxClipboardText+1)}, {Text: "x\x00y"}, {Text: "\xff"}, {PNG: []byte("not PNG")},
		{Files: []string{}}, {Files: []string{"relative"}}, {Files: []string{"/tmp/../etc/passwd"}}, {Files: []string{"/a\x00b"}},
		{Text: "ambiguous", Files: []string{"/tmp/a"}}, {PNG: clipboardPNG(t), Files: []string{"/tmp/a"}},
	} {
		if validateClipboard(data) == nil {
			t.Fatalf("invalid clipboard admitted: %v", len(data.PNG))
		}
	}
	for _, uri := range []string{"https://example.com/a", "file://another-server/a", "file:///tmp/a?query", "file:///a#fragment", "file:///a%00b", "file:///tmp/../a"} {
		if _, err := clipboardPaths(uri); err == nil {
			t.Fatalf("invalid URI admitted: %s", uri)
		}
	}
	paths, err := clipboardPaths("cut\nfile:///tmp/space%20and%20%E6%97%A5.txt\r\nfile://localhost/tmp/a%0Ab\r\n")
	if err != nil || len(paths) != 2 || paths[0] != "/tmp/space and 日.txt" || paths[1] != "/tmp/a\nb" {
		t.Fatalf("URI decoding: %#v %v", paths, err)
	}
}

func TestNativeClipboard(t *testing.T) {
	user := testUser(t)
	d, err := Prepare(user)
	if err != nil || d == nil {
		t.Fatal(err)
	}
	defer d.Close()
	app := user.Command(context.Background(), "xterm", "-title", "Clipboard test")
	app.Env = append(app.Env, d.Env...)
	if err = app.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { app.Process.Kill(); app.Wait() }()
	waitFor(t, func() bool { return len(d.State().Windows) == 1 })
	changes, release, err := d.ClipboardChanges()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	<-changes
	pngBytes := clipboardPNG(t)
	if len(pngBytes) <= selectionChunk {
		t.Fatal("fixture must exercise INCR")
	}
	if err = d.SetClipboard(ClipboardData{PNG: pngBytes}); err != nil {
		t.Fatal(err)
	}
	read := user.Command(context.Background(), "xclip", "-o", "-selection", "clipboard", "-target", "image/png")
	read.Env = append(read.Env, d.Env...)
	got, err := read.Output()
	if err != nil || !bytes.Equal(got, pngBytes) {
		t.Fatalf("incremental send: bytes=%d err=%v", len(got), err)
	}
	// xclip is a real external owner and sends its large payload incrementally too.
	source := user.Command(context.Background(), "xclip", "-quiet", "-selection", "clipboard", "-target", "image/png")
	source.Env = append(source.Env, d.Env...)
	source.Stdin = bytes.NewReader(pngBytes)
	if err = source.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { source.Process.Kill(); source.Wait() }()
	var revision uint64
	deadline := time.After(5 * time.Second)
	for revision == 0 {
		select {
		case change := <-changes:
			if !change.Local {
				revision = change.Version
			}
		case <-deadline:
			t.Fatal("no clipboard notification")
		}
	}
	data, err := d.ReadClipboard(context.Background(), revision)
	if err != nil || !bytes.Equal(data.PNG, pngBytes) {
		t.Fatalf("incremental receive: bytes=%d err=%v", len(data.PNG), err)
	}
	if _, err = d.ReadClipboard(context.Background(), revision+1); err == nil {
		t.Fatal("stale clipboard version accepted")
	}
	if err = d.SetClipboard(ClipboardData{Files: []string{"/tmp/space and 日.txt", "/tmp/a\nb"}}); err != nil {
		t.Fatal(err)
	}
	uris := user.Command(context.Background(), "xclip", "-o", "-selection", "clipboard", "-target", "text/uri-list")
	uris.Env = append(uris.Env, d.Env...)
	value, err := uris.Output()
	if err != nil {
		t.Fatal(err)
	}
	paths, err := clipboardPaths(string(value))
	if err != nil || len(paths) != 2 || paths[1] != "/tmp/a\nb" {
		t.Fatalf("file round-trip: %q %v", value, err)
	}
	c, _ := d.clipboard()
	c.mu.Lock()
	c.data = map[xproto.Atom][]byte{c.atoms["text/uri-list"]: []byte("https://example.com/\r\n"), c.atoms["UTF8_STRING"]: []byte("https://example.com/")}
	version := c.change.Version
	c.mu.Unlock()
	data, err = d.ReadClipboard(context.Background(), version)
	if err != nil || data.Text != "https://example.com/" || data.Files != nil {
		t.Fatalf("copied link mistaken for files: %+v %v", data, err)
	}
	if err = d.DropFiles(context.Background(), FileDrop{Files: []string{"/tmp/a"}, Window: 0}); err == nil {
		t.Fatal("unknown window accepted")
	}
	d.Close()
	select {
	case _, ok := <-changes:
		if ok {
			select {
			case _, ok = <-changes:
				if ok {
					t.Fatal("clipboard stream survived display close")
				}
			case <-time.After(time.Second):
				t.Fatal("clipboard stream not closed")
			}
		}
	case <-time.After(time.Second):
		t.Fatal("clipboard stream not closed")
	}
}
