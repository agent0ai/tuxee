package files

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTerminalHistoryAndCleanup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	ctx := context.Background()
	live, dead, other := strings.Repeat("1", 24), strings.Repeat("2", 24), strings.Repeat("3", 24)
	base := filepath.Join(home, ".config", "tuxee", "terminals")
	run := func(r Request) Response {
		t.Helper()
		response, err := terminalFiles(ctx, r)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	run(Request{Operation: "terminal-prune", Instance: "one", Paths: []string{live, dead}})
	run(Request{Operation: "terminal-prune", Instance: "two", Paths: []string{other}})
	for i := range 55 {
		r := Request{Operation: "terminal-history", Instance: "one", Path: live, Content: fmt.Sprintf("line %d\n日本語 🦊", i)}
		run(r)
		run(r) // Consecutive exact duplicates collapse.
	}
	history := run(Request{Operation: "terminal-history", Instance: "one", Path: live}).History
	if len(history) != 50 || history[0] != "line 5\n日本語 🦊" || history[49] != "line 54\n日本語 🦊" {
		t.Fatalf("incorrect history bounds or content: %v", history)
	}
	path := filepath.Join(base, live, "input-history.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved []string
	if err := json.Unmarshal(data, &saved); err != nil || !reflect.DeepEqual(saved, history) {
		t.Fatalf("saved history differs: %v", err)
	}
	for p, mode := range map[string]os.FileMode{filepath.Join(base, live): 0700, path: 0600, filepath.Join(base, live, "meta.json"): 0600} {
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("private mode for %s: %v %v", p, info, err)
		}
	}
	for _, r := range []Request{
		{Operation: "terminal-history", Instance: "one", Path: "../settings.json", Content: "no"},
		{Operation: "terminal-history", Instance: "one", Path: live, Content: strings.Repeat("x", InputHistoryEntryBytes+1)},
		{Operation: "terminal-history", Instance: "two", Path: live, Content: "wrong installation"},
		{Operation: "terminal-prune", Instance: "one", Paths: []string{".."}},
	} {
		if _, err := terminalFiles(ctx, r); err == nil {
			t.Fatalf("accepted invalid request: %s %s", r.Operation, r.Path)
		}
	}
	unchanged, _ := os.ReadFile(path)
	if string(unchanged) != string(data) {
		t.Fatal("invalid writes changed saved history")
	}
	unknown := filepath.Join(base, strings.Repeat("4", 24))
	if err := os.Mkdir(unknown, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, strings.Repeat("5", 24))
	if err := os.Symlink(filepath.Join(base, other), link); err != nil {
		t.Fatal(err)
	}
	run(Request{Operation: "terminal-prune", Instance: "one", Paths: []string{live}})
	if _, err := os.Stat(filepath.Join(base, dead)); !os.IsNotExist(err) {
		t.Fatal("dead terminal folder survived cleanup")
	}
	for _, p := range []string{path, filepath.Join(base, other), unknown, link} {
		if _, err := os.Lstat(p); err != nil {
			t.Fatalf("cleanup removed unrelated/live data %s: %v", p, err)
		}
	}
	run(Request{Operation: "terminal-prune", Instance: "one"})
	if _, err := os.Stat(filepath.Join(base, live)); !os.IsNotExist(err) {
		t.Fatal("last terminal folder survived cleanup")
	}
}

func TestTerminalHistoryRejectsCorruptAndSpecialFiles(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	id := strings.Repeat("a", 24)
	r := Request{Operation: "terminal-history", Instance: "one", Path: id, Content: "first"}
	if _, err := terminalFiles(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(os.Getenv("HOME"), ".config", "tuxee", "terminals", id, "input-history.json")
	if err := os.WriteFile(path, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := terminalFiles(context.Background(), r); err == nil {
		t.Fatal("corrupt history was overwritten")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "{broken" {
		t.Fatal("corrupt history lost")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/dev/zero", path); err != nil {
		t.Fatal(err)
	}
	if _, err := terminalFiles(context.Background(), r); err == nil {
		t.Fatal("followed history symlink")
	}
}
