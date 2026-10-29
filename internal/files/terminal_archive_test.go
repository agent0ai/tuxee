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
	archive := json.RawMessage(`{"version":2,"capturedAt":"2026-10-28T00:00:00Z","text":"界 🦊\nsecond line  "}`)
	record := TerminalRecord{Name: "saved", Directory: home, State: "live"}
	r := Request{Operation: "terminal-record", Instance: "one", Path: id, Terminal: &record, Archive: archive}
	run(r)
	plain, err := os.ReadFile(filepath.Join(base, id, "output.txt"))
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
	path := filepath.Join(base, id, "output.txt")
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

func TestTerminalArchiveEarlyPreview(t *testing.T) {
	path := t.TempDir()
	for name, data := range map[string]string{
		"output.json":   `{"version":1,"normal":{"capturedAt":"2026-10-28T00:00:00Z"},"alternate":{"capturedAt":"2026-10-28T00:00:01Z"}}`,
		"normal.txt":    "shell before app\n     \n     ",
		"alternate.txt": "actual app screen\n     ",
	} {
		if err := os.WriteFile(filepath.Join(path, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	data, err := readTerminalArchive(path)
	if err != nil {
		t.Fatal(err)
	}
	var value TerminalArchive
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	if value.Version != 2 || value.Text != "shell before app\nactual app screen" {
		t.Fatalf("discarded early preview output: %s", data)
	}
}

func TestTerminalLifecycleMetadataAndDelete(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", "")
	base := filepath.Join(os.Getenv("HOME"), ".local/state/tuxee/terminals")
	id := strings.Repeat("b", 24)
	ctx := context.Background()
	run := func(r Request) Response {
		t.Helper()
		response, err := terminalFiles(ctx, r)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	started := time.Now().UTC().Add(-time.Minute)
	record := TerminalRecord{State: "live", StartedAt: &started}
	run(Request{Operation: "terminal-record", Instance: "one", Path: id, Terminal: &record})
	remove := Request{Operation: "terminal-delete", Instance: "one", Path: id}
	if _, err := terminalFiles(ctx, remove); err == nil {
		t.Fatal("deleted live terminal")
	}
	run(Request{Operation: "terminal-prune", Instance: "one", Paths: []string{id}})
	meta, _ := terminalRecord(base, id, "one")
	if !meta.StartedAt.Equal(started) || meta.FoundDeadAt != nil {
		t.Fatalf("live metadata: %+v", meta)
	}
	run(Request{Operation: "terminal-prune", Instance: "one"})
	meta, _ = terminalRecord(base, id, "one")
	if meta.FoundDeadAt == nil || meta.TerminatedAt != nil {
		t.Fatalf("unknown death: %+v", meta)
	}
	found := *meta.FoundDeadAt
	run(Request{Operation: "terminal-prune", Instance: "one"})
	meta, _ = terminalRecord(base, id, "one")
	if !meta.FoundDeadAt.Equal(found) {
		t.Fatal("changed discovery timestamp")
	}
	if _, err := terminalFiles(ctx, remove); err == nil {
		t.Fatal("deleted unclosed dead terminal")
	}
	run(Request{Operation: "terminal-close", Instance: "one", Path: id})
	meta, _ = terminalRecord(base, id, "one")
	for _, hours := range []int{168, 72, 0} {
		settings, _ := json.Marshal(map[string]int{"closedTerminalHistoryHours": hours})
		if _, _, err := execute(ctx, Request{Operation: "settings-save", Settings: settings}, nil); err != nil {
			t.Fatal(err)
		}
		list := run(Request{Operation: "terminal-list", Instance: "one"}).Terminals
		if len(list) != 1 || !list[0].ExpiresAt.Equal(meta.ClosedAt.Add(time.Duration(hours)*time.Hour)) {
			t.Fatalf("wrong current expiry: %+v", list)
		}
	}
	foreign := remove
	foreign.Instance = "two"
	if _, err := terminalFiles(ctx, foreign); err == nil {
		t.Fatal("cross-installation deletion")
	}
	run(remove)
	if _, err := os.Stat(filepath.Join(base, id)); !os.IsNotExist(err) {
		t.Fatal("archive folder remained")
	}
	if _, err := terminalFiles(ctx, Request{Operation: "terminal-close", Instance: "one", Path: id}); err == nil {
		t.Fatal("late close recreated deleted archive")
	}
	terminated := time.Now().UTC()
	record.State, record.TerminatedAt = "dead", &terminated
	run(Request{Operation: "terminal-record", Instance: "one", Path: id, Terminal: &record})
	run(Request{Operation: "terminal-prune", Instance: "one"})
	meta, _ = terminalRecord(base, id, "one")
	if !meta.TerminatedAt.Equal(terminated) || meta.FoundDeadAt != nil {
		t.Fatalf("known death became discovered death: %+v", meta)
	}
}
