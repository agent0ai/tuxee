package terminal

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"tuxee/internal/files"
	"tuxee/internal/identity"
)

func archiveFixture(t *testing.T, columns, rows int) (*Engine, func(string), func() string) {
	t.Helper()
	e, err := NewEngine(columns, rows)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Close)
	apply := func(text string) {
		t.Helper()
		if _, err := e.Apply([]byte(text), 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	capture := func() string {
		t.Helper()
		data, err := e.call("archive")
		if err != nil {
			t.Fatal(err)
		}
		var value files.TerminalArchive
		if err := json.Unmarshal([]byte(data), &value); err != nil {
			t.Fatal(err)
		}
		if value.Version != 2 || value.CapturedAt.IsZero() {
			t.Fatalf("invalid archive: %s", data)
		}
		return value.Text
	}
	return e, apply, capture
}

func TestVisualArchiveTimeline(t *testing.T) {
	_, apply, capture := archiveFixture(t, 20, 5)
	apply("BEFORE 界 🦊 é\r\n\x1b[?1049h\x1b[HAPP ONE")
	first := capture()
	if !strings.Contains(first, "BEFORE 界 🦊 é") || !strings.Contains(first, "APP ONE") {
		t.Fatalf("lost active screen: %q", first)
	}
	// A clear before exit must preserve the last sampled useful screen.
	apply("\x1b[2J\x1b[?1049lBETWEEN\r\n\x1b[?1049h\x1b[HAPP TWO\x1b[?1049lAFTER\r\n")
	output := capture()
	last := -1
	for _, part := range []string{"BEFORE 界 🦊 é", "APP ONE", "BETWEEN", "APP TWO", "AFTER"} {
		at := strings.Index(output, part)
		if at <= last || strings.Count(output, part) != 1 {
			t.Fatalf("lost/repeated/reordered %q: %q", part, output)
		}
		last = at
	}
	if capture() != output {
		t.Fatal("capture duplicated the transcript")
	}
	if strings.TrimSpace(strings.Split(output, "\n")[strings.Count(output, "\n")]) != "AFTER" {
		t.Fatal("unused shell rows were retained")
	}
}

func TestVisualArchiveShellRows(t *testing.T) {
	_, apply, capture := archiveFixture(t, 10, 24)
	if capture() != "" {
		t.Fatal("empty terminal acquired blank screen rows")
	}
	apply("ab界🐧e\u0301  \r\n12345678界x\r\n\r\n")
	output := capture()
	if output != "ab界🐧é   \n12345678界\nx         \n          " {
		t.Fatalf("Unicode, padding, wraps or intentional blank line lost: %q", output)
	}
	apply("partial\x1b[?1049hAPP\x1b[?1049lcontinued")
	output = capture()
	if strings.Count(output, "partial") != 1 || !strings.Contains(strings.ReplaceAll(output, "\n", ""), "continued") {
		t.Fatalf("partial shell boundary duplicated: %q", output)
	}
}

func TestVisualArchiveNormalFullscreen(t *testing.T) {
	e, apply, capture := archiveFixture(t, 40, 8)
	apply("BEFORE\r\n\x1b[?1h\x1b[?25l\x1b[H\x1b[2JOLD FRAME")
	apply("\x1b[?25hINPUT PROMPT\x1b[?25l")
	apply("\x1b[H\x1b[2JLAST FRAME")
	if _, err := e.Apply(nil, 30, 6); err != nil {
		t.Fatal(err)
	}
	apply("\x1b[H\x1b[2JRESIZED FRAME\x1b[?1l\x1b[6;1H\r\n\x1b[?25hAFTER\r\n")
	apply("\x1b[?1h\x1b[?25l\x1b[H\x1b[2JSECOND FRAME")
	_ = capture()
	apply("\x1b[H\x1b[2J\x1b[?1l\x1b[6;1H\x1b[?25hFINAL\r\n")
	output := capture()
	last := -1
	for _, part := range []string{"BEFORE", "RESIZED FRAME", "AFTER", "SECOND FRAME", "FINAL"} {
		at := strings.Index(output, part)
		if at <= last || strings.Count(output, part) != 1 {
			t.Fatalf("normal-screen redraw lost/repeated/reordered %q: %q", part, output)
		}
		last = at
	}
	if strings.Contains(output, "OLD FRAME") || strings.Contains(output, "LAST FRAME") {
		t.Fatalf("retained intermediate redraws: %q", output)
	}
}

func TestVisualArchivePartialLineReflow(t *testing.T) {
	e, apply, capture := archiveFixture(t, 20, 5)
	apply("PREFIX_12345678\x1b[?1049h\x1b[HAPP\x1b[?1049l")
	if _, err := e.Apply(nil, 10, 5); err != nil {
		t.Fatal(err)
	}
	apply("SUFFIX\r\n")
	output := capture()
	if strings.Count(output, "PREFIX_12345678") != 1 || !strings.Contains(strings.ReplaceAll(output, "\n", ""), "SUFFIX") {
		t.Fatalf("reflow broke the continuation: %q", output)
	}
}

func TestVisualArchiveReset(t *testing.T) {
	_, apply, capture := archiveFixture(t, 30, 6)
	apply("BEFORE\r\n\x1b[?1049h\x1b[HAPPLICATION")
	_ = capture()
	apply("\x1bcAFTER\r\n\x1bcSHELL RESET\r\n\x1b[?1h\x1b[?25l\x1b[HNORMAL APP")
	_ = capture()
	apply("\x1bcFINAL\r\n")
	output := capture()
	last := -1
	for _, part := range []string{"BEFORE", "APPLICATION", "AFTER", "SHELL RESET", "NORMAL APP", "FINAL"} {
		at := strings.Index(output, part)
		if at <= last || strings.Count(output, part) != 1 {
			t.Fatalf("terminal reset lost/repeated/reordered %q: %q", part, output)
		}
		last = at
	}
}

func TestVisualArchiveBounds(t *testing.T) {
	e, apply, capture := archiveFixture(t, 240, 30)
	line := strings.Repeat("x", 239) + "\r\n"
	for range 30 {
		apply(strings.Repeat(line, 100))
	}
	for range 100 {
		apply("shell\r\n\x1b[?1049happlication\x1b[?1049l")
	}
	output := capture()
	if rows := strings.Count(output, "\n") + 1; rows > 5000 || rows*240 > 512000 {
		t.Fatalf("combined transcript exceeded bounds: %d", rows)
	}
	// Committed history must survive clearing live scrollback and resizing.
	apply("UNIQUE_AFTER_APP\r\n\x1b[3J")
	if _, err := e.Apply(nil, 80, 30); err != nil {
		t.Fatal(err)
	}
	apply("AFTER_RESIZE\r\n")
	output = capture()
	if strings.Count(output, "UNIQUE_AFTER_APP") != 1 || strings.Count(output, "AFTER_RESIZE") != 1 {
		t.Fatalf("resize lost/duplicated shell continuation: %q", output)
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
	info := inventory[0]
	if info.StartedAt == nil || info.TerminatedAt == nil || info.TerminatedAt.Before(*info.StartedAt) || info.FoundDeadAt != nil || info.ExpiresAt == nil {
		t.Fatalf("incorrect lifecycle metadata: %+v", info)
	}
	archive, err := m.Archive(context.Background(), user, s.Info().ID)
	if err != nil || !strings.Contains(string(archive), "final") {
		t.Fatalf("final output lost: %s %v", archive, err)
	}
	var pending sync.WaitGroup
	pending.Add(1)
	go func() {
		defer pending.Done()
		for range 5 {
			s.checkpoint()
			s.Close()
		}
	}()
	if err := m.DeleteArchive(context.Background(), user, info.ID); err != nil {
		t.Fatal(err)
	}
	pending.Wait()
	if records, err := m.ArchiveInventory(context.Background(), user); err != nil || len(records) != 0 {
		t.Fatalf("late lifecycle calls recreated deleted archive: %+v %v", records, err)
	}
}

func TestTerminalUsageRetention(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	t.Setenv("XDG_STATE_HOME", "")
	for _, tc := range []struct {
		name, input, command string
		ended, failedCapture bool
	}{
		{name: "untouched"},
		{name: "arrow", input: "\x1b[A"},
		{name: "enter", input: "\r"},
		{name: "command", command: "sleep 30"},
		{name: "shutdown", ended: true},
		{name: "capture-failure", input: "\r", failedCapture: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			user := identity.User{Name: "root", Home: t.TempDir(), Shell: "/bin/sh"}
			m := NewManager()
			m.HistoryInstance = "usage-test"
			defer m.Close()
			s, err := m.Create(user, user.Home, tc.name, 80, 24, tc.command, "", "", user.Shell, false, "en")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			a, err := s.Attach(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			if err := a.Resize(81, 25); err != nil {
				t.Fatal(err)
			}
			if err := a.Write(ctx, nil); err == nil {
				t.Fatal("accepted empty input")
			}
			observer, err := s.Attach(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err := observer.Write(ctx, []byte("x")); err == nil {
				t.Fatal("accepted observer input")
			}
			observer.Close()
			s.mu.Lock()
			err = s.inputLocked([]byte("\x1b[0n"))
			s.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			if tc.input != "" {
				if err := a.Write(ctx, []byte(tc.input)); err != nil {
					t.Fatal(err)
				}
			}
			folder := filepath.Join(user.Home, ".local/state/tuxee/terminals", s.Info().ID)
			if tc.failedCapture {
				if err := os.Remove(filepath.Join(folder, "output.json")); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(folder, "output.json"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			s.checkpoint()
			if tc.ended {
				s.close(false)
				inventory, err := m.ArchiveInventory(ctx, user)
				if err != nil || len(inventory) != 1 || inventory[0].ClosedAt != nil {
					t.Fatalf("unused unclosed archive lost: %+v %v", inventory, err)
				}
				if err := m.CloseArchive(ctx, user, s.Info().ID); err != nil {
					t.Fatal(err)
				}
			} else {
				s.Close()
			}
			used := tc.input != "" || tc.command != ""
			data, err := os.ReadFile(filepath.Join(folder, "meta.json"))
			if !used {
				if !os.IsNotExist(err) {
					t.Fatalf("untouched terminal retained: %s %v", data, err)
				}
				s.checkpoint()
			} else {
				var record files.TerminalRecord
				if err != nil || json.Unmarshal(data, &record) != nil || record.Used == nil || !*record.Used || record.ClosedAt == nil {
					t.Fatalf("used terminal not retained: %s %v", data, err)
				}
			}
			inventory, err := m.ArchiveInventory(ctx, user)
			if err != nil || (len(inventory) == 1) != used {
				t.Fatalf("incorrect inventory: %+v %v", inventory, err)
			}
		})
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
