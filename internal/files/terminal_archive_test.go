package files

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTerminalArchiveRetentionAndIsolation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	base := filepath.Join(home, ".local/state/tuxee/terminals")
	id := strings.Repeat("a", 24)
	ctx := context.Background()
	run := func(r Request) Response {
		t.Helper()
		out, err := terminalFiles(ctx, r)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	archive := json.RawMessage(`{"version":1,"active":"normal","normal":{"columns":80,"rows":24,"capturedAt":"2026-10-28T00:00:00Z","text":"界 🦊\nsecond line  "}}`)
	record := TerminalRecord{Name: "saved", Directory: home, State: "live"}
	r := Request{Operation: "terminal-record", Instance: "one", Path: id, Terminal: &record, Archive: archive}
	run(r)
	plain, err := os.ReadFile(filepath.Join(base, id, "normal.txt"))
	if err != nil || string(plain) != "界 🦊\nsecond line  " {
		t.Fatalf("not searchable plain text: %q %v", plain, err)
	}
	dimensions, err := os.ReadFile(filepath.Join(base, id, "output.json"))
	if err != nil || bytes.Contains(dimensions, []byte("second line")) {
		t.Fatal("output text leaked into metadata")
	}
	run(Request{Operation: "terminal-history", Instance: "one", Path: id, Content: "original\n日本語"})
	run(Request{Operation: "terminal-prune", Instance: "one"})
	meta, err := terminalRecord(base, id, "one")
	if err != nil || meta.State != "dead" || meta.ClosedAt != nil {
		t.Fatalf("death started expiry: %+v %v", meta, err)
	}
	output := run(Request{Operation: "terminal-archive", Instance: "one", Path: id}).Archive
	if !bytes.Contains(output, []byte("界 🦊")) {
		t.Fatal("lost archive text")
	}
	if _, err := terminalFiles(ctx, Request{Operation: "terminal-archive", Instance: "two", Path: id}); err == nil {
		t.Fatal("cross-installation read")
	}
	run(Request{Operation: "terminal-close", Instance: "one", Path: id})
	meta, _ = terminalRecord(base, id, "one")
	if meta.State != "closed" || meta.ClosedAt == nil {
		t.Fatal("closure did not start expiry")
	}
	closed := *meta.ClosedAt
	run(r)
	run(Request{Operation: "terminal-close", Instance: "one", Path: id})
	meta, _ = terminalRecord(base, id, "one")
	if meta.State != "closed" || !meta.ClosedAt.Equal(closed) {
		t.Fatal("late writes reopened or extended closed archive")
	}
	run(Request{Operation: "terminal-prune", Instance: "one"})
	if _, err := os.Stat(filepath.Join(base, id)); err != nil {
		t.Fatal("expired too soon")
	}
	ago := time.Now().Add(-169 * time.Hour)
	meta.ClosedAt = &ago
	if err := saveTerminalRecord(base, meta); err != nil {
		t.Fatal(err)
	}
	run(Request{Operation: "terminal-prune", Instance: "two"})
	if _, err := os.Stat(filepath.Join(base, id)); err != nil {
		t.Fatal("other installation expired archive")
	}
	run(Request{Operation: "terminal-prune", Instance: "one"})
	if _, err := os.Stat(filepath.Join(base, id)); !os.IsNotExist(err) {
		t.Fatal("default expiry failed")
	}
	run(r)
	run(Request{Operation: "terminal-close", Instance: "one", Path: id})
	_, _, err = execute(ctx, Request{Operation: "settings-save", Settings: json.RawMessage(`{"closedTerminalHistoryHours":0}`)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	run(Request{Operation: "terminal-prune", Instance: "one"})
	if _, err := os.Stat(filepath.Join(base, id)); !os.IsNotExist(err) {
		t.Fatal("zero-hour expiry failed")
	}
	run(r)
	path := filepath.Join(base, id, "normal.txt")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, id, "input-history.json"), path); err != nil {
		t.Fatal(err)
	}
	if _, err := terminalFiles(ctx, Request{Operation: "terminal-archive", Instance: "one", Path: id}); err == nil {
		t.Fatal("followed archive symlink")
	}
}
