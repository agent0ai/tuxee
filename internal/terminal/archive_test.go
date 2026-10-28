package terminal

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"tuxee/internal/files"
	"tuxee/internal/identity"
)

type visualArchive struct {
	Version   int
	Active    string
	Normal    visualFrame
	Alternate *visualFrame
}
type visualFrame struct {
	Columns, Rows    int
	CapturedAt, Text string
}

func TestVisualArchiveBuffers(t *testing.T) {
	e, err := NewEngine(10, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	apply := func(text string) {
		t.Helper()
		if _, err := e.Apply([]byte(text), 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	capture := func() visualArchive {
		t.Helper()
		data, err := e.call("archive")
		if err != nil {
			t.Fatal(err)
		}
		var a visualArchive
		if err := json.Unmarshal([]byte(data), &a); err != nil {
			t.Fatal(err)
		}
		return a
	}
	apply("ab界🐧e\u0301  \r\n12345678界x\r\n")
	a := capture()
	if a.Version != 1 || a.Active != "normal" || a.Normal.Columns != 10 || a.Normal.Rows != 3 || !strings.Contains(a.Normal.Text, "ab界🐧é   \n12345678界\nx") {
		t.Fatalf("Unicode/spacing/wrap lost: %q", a.Normal.Text)
	}
	apply("\x1b[?1049h\x1b[Huseful")
	a = capture()
	if a.Alternate == nil || !strings.HasPrefix(a.Alternate.Text, "useful") || a.Active != "alternate" {
		t.Fatalf("alternate missing: %+v", a)
	}
	previous := *a.Alternate
	apply("\x1b[2J\x1b[?1049l\r\nreturned")
	a = capture()
	if a.Active != "normal" || a.Alternate == nil || *a.Alternate != previous || !strings.Contains(a.Normal.Text, "returned") {
		t.Fatalf("cleared alternate replaced useful frame: %+v", a)
	}
	apply("\x1b[?1049h\x1b[Hone\x1b[?1049l\x1b[?1049h\x1b[Htwo\x1b[?1049l")
	a = capture()
	if a.Alternate == nil || !strings.HasPrefix(a.Alternate.Text, "two") || a.Active != "normal" {
		t.Fatalf("same-batch transitions lost: %+v", a)
	}
}

func TestVisualArchiveBounds(t *testing.T) {
	e, err := NewEngine(240, 30)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	line := strings.Repeat("x", 239) + "\r\n"
	for range 30 {
		if _, err := e.Apply([]byte(strings.Repeat(line, 100)), 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	data, err := e.call("archive")
	if err != nil {
		t.Fatal(err)
	}
	var a visualArchive
	if err := json.Unmarshal([]byte(data), &a); err != nil {
		t.Fatal(err)
	}
	if rows := strings.Count(a.Normal.Text, "\n") + 1; rows > 5030 || rows*240 > 512000 {
		t.Fatalf("archive exceeded canonical history: %d", rows)
	}
}

func TestExplicitCloseAfterNaturalExit(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	t.Setenv("XDG_STATE_HOME", "")
	user := identity.User{Name: "root", Home: t.TempDir(), Shell: "/bin/sh"}
	m := NewManager()
	m.HistoryInstance = "archive-race"
	defer m.Close()
	s, err := m.Create(user, user.Home, "exit", 80, 24, "printf final", "", "", user.Shell, false, "en")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.done:
	case <-time.After(10 * time.Second):
		t.Fatal("natural exit did not release the session")
	}
	// DELETE may already hold this pointer when natural cleanup wins the lock.
	s.Close()
	inventory, err := m.ArchiveInventory(context.Background(), user)
	if err != nil || len(inventory) != 1 || inventory[0].ClosedAt == nil {
		t.Fatalf("explicit close was lost: %+v %v", inventory, err)
	}
	archive, err := m.Archive(context.Background(), user, s.Info().ID)
	if err != nil || !strings.Contains(string(archive), "final") {
		t.Fatalf("final output lost: %s %v", archive, err)
	}
}

func TestArchiveCleanupRegisteredIdentity(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	user, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	m.HistoryInstance = "registry-test"
	m.StartArchives(t.TempDir())
	defer m.Close()
	m.RegisterArchiveUser(user)
	id := strings.Repeat("d", 24)
	if _, err := files.Run(context.Background(), user, files.Request{Operation: "terminal-prune", Instance: m.HistoryInstance, Paths: []string{id}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(os.Getenv("XDG_STATE_HOME"), "tuxee", "terminals", id, "meta.json")
	closed := time.Now().Add(-169 * time.Hour)
	data, _ := json.Marshal(files.TerminalRecord{InstanceID: m.HistoryInstance, ID: id, State: "closed", ClosedAt: &closed})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	// The hourly job resolves the current account and must not follow a reused UID/name pair.
	m.mu.Lock()
	m.archiveAccounts[user.Name] = user.UID + 1
	m.mu.Unlock()
	m.cleanArchives()
	if _, err := os.Stat(path); err != nil {
		t.Fatal("cleanup crossed identity mismatch")
	}
	m.mu.Lock()
	m.archiveAccounts[user.Name] = user.UID
	m.mu.Unlock()
	m.cleanArchives()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("registered cleanup did not expire archive")
	}
}

func TestArchiveFailureKeepsShellUsable(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	home := t.TempDir()
	state := filepath.Join(home, "not-a-directory")
	if err := os.WriteFile(state, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_STATE_HOME", state)
	user := identity.User{Name: "root", Home: home, Shell: "/bin/sh"}
	m := NewManager()
	m.HistoryInstance = "failure-test"
	defer m.Close()
	s, err := m.Create(user, home, "", 80, 24, "", "", "", user.Shell, false, "en")
	if err != nil {
		t.Fatalf("recording failure prevented shell creation: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a, err := s.Attach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := a.Write(ctx, []byte("printf 'ARCHIVE_%s\\n' STILL_WORKS\r")); err != nil {
		t.Fatal(err)
	}
	text := ""
	for !strings.Contains(text, "ARCHIVE_STILL_WORKS") {
		select {
		case event := <-a.Events:
			text += string(event.Data)
			a.Release(event)
		case <-ctx.Done():
			t.Fatal("recording failure disrupted PTY output")
		}
	}
	data, err := os.ReadFile(state)
	if err != nil || string(data) != "keep" {
		t.Fatal("recording failure changed unrelated file")
	}
}
