package files

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTerminalDraft(t *testing.T) {
	for _, xdg := range []bool{false, true} {
		t.Run(map[bool]string{false: "home", true: "xdg"}[xdg], func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_STATE_HOME", "")
			state := filepath.Join(home, ".local", "state")
			if xdg {
				state = t.TempDir()
				t.Setenv("XDG_STATE_HOME", state)
			}
			id := strings.Repeat("a", 24)
			base := filepath.Join(state, "tuxee", "terminals")
			if err := prepareTerminalFolder(base, id, "one"); err != nil {
				t.Fatal(err)
			}
			r := Request{Operation: "terminal-draft", Instance: "one", Path: id}
			run := func() *TerminalDraft {
				t.Helper()
				response, err := terminalFiles(context.Background(), r)
				if err != nil {
					t.Fatal(err)
				}
				return response.Draft
			}
			if draft := run(); *draft != (TerminalDraft{}) {
				t.Fatalf("unexpected initial draft: %+v", draft)
			}
			r.Draft = &TerminalDraft{Text: "Long instruction\n日本語 🦊\n", Open: true}
			saved := run()
			if saved.Text != r.Draft.Text || !saved.Open || saved.Revision == "" {
				t.Fatalf("invalid saved draft: %+v", saved)
			}
			if *run() != *saved {
				t.Fatal("retry was not idempotent")
			}
			path := filepath.Join(base, id, "input-draft.json")
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("draft permissions: %v %v", info, err)
			}
			for _, invalid := range []Request{
				{Operation: r.Operation, Instance: "one", Path: id, Draft: &TerminalDraft{Text: "stale write"}},
				{Operation: r.Operation, Instance: "two", Path: id, Draft: saved},
				{Operation: r.Operation, Instance: "one", Path: "../other", Draft: saved},
				{Operation: r.Operation, Instance: "one", Path: id, Draft: &TerminalDraft{Text: strings.Repeat("x", InputDraftBytes+1)}},
			} {
				if _, err := terminalFiles(context.Background(), invalid); err == nil {
					t.Fatal("accepted invalid or conflicting draft")
				}
			}
			r.Draft = nil
			if *run() != *saved {
				t.Fatal("rejected request changed draft")
			}
			r.Draft = &TerminalDraft{Revision: saved.Revision}
			cleared := run()
			if cleared.Text != "" || cleared.Open || cleared.Revision == saved.Revision {
				t.Fatal("clear did not persist")
			}
			data, err := os.ReadFile(path)
			var disk TerminalDraft
			if err != nil || json.Unmarshal(data, &disk) != nil || disk != *cleared {
				t.Fatal("disk content differs")
			}
			for _, corrupt := range []string{"{broken", "{}", `{"revision":"a","text":"` + strings.Repeat("x", InputDraftBytes+1) + `"}`} {
				if err := os.WriteFile(path, []byte(corrupt), 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := terminalFiles(context.Background(), r); err == nil {
					t.Fatal("overwrote corrupt draft")
				}
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("/dev/zero", path); err != nil {
				t.Fatal(err)
			}
			if _, err := terminalFiles(context.Background(), r); err == nil {
				t.Fatal("followed symlink")
			}
			if err := os.RemoveAll(filepath.Join(base, id)); err != nil {
				t.Fatal(err)
			}
			if _, err := terminalFiles(context.Background(), r); err == nil {
				t.Fatal("recreated deleted terminal")
			}
		})
	}
}
