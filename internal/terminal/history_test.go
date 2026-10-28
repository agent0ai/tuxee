package terminal

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"tuxee/internal/files"
	"tuxee/internal/identity"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "__files" {
		if files.Worker() != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestInputHistoryConcurrentAppendAndClose(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "")
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	user := identity.User{Name: "root", Home: t.TempDir(), Shell: "/bin/sh"}
	m := NewManager()
	m.HistoryInstance = "history-test"
	defer m.Close()
	s, err := m.Create(user, user.Home, "history", 80, 24, "", "", "", user.Shell, false, "en")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var writers sync.WaitGroup
	for i := range 12 {
		writers.Go(func() {
			if _, err := s.InputHistory(ctx, "entry "+strconv.Itoa(i)); err != nil {
				t.Error(err)
			}
		})
	}
	writers.Wait()
	history, err := s.InputHistory(ctx, "")
	if err != nil || len(history) != 12 {
		t.Fatalf("lost concurrent appends: %v, %v", history, err)
	}
	if _, err := s.InputHistory(ctx, strings.Repeat("x", files.InputHistoryEntryBytes+1)); err == nil {
		t.Fatal("accepted oversized entry")
	}
	for i := range 12 {
		writers.Go(func() { _, _ = s.InputHistory(ctx, "closing "+strconv.Itoa(i)) })
	}
	writers.Go(func() { m.PruneHistory(user) })
	s.Close()
	writers.Wait()
	if _, err := s.InputHistory(ctx, "late write"); err == nil {
		t.Fatal("closed session accepted history")
	}
	if history, err := s.InputHistory(ctx, ""); err != nil || len(history) != 0 {
		t.Fatalf("closed history: %v, %v", history, err)
	}
	path := filepath.Join(user.Home, ".local", "state", "tuxee", "terminals", s.Info().ID)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("append recreated closed session folder: %v", err)
	}
}
