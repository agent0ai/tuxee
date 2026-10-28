package files

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "__files" {
		if err := Worker(); err != nil {
			_ = json.NewEncoder(os.Stderr).Encode(i18n.Describe(err))
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestWorkerEarlyErrorRetainsTranslation(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	user, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = Start(ctx, user, Request{Operation: "read", Path: strings.Repeat("x", 9<<20)}, nil)
	message := i18n.Describe(err)
	if message == nil || message.Key != "backend.files.workerRequestTooLarge" {
		t.Fatalf("worker lost translation before its response header: %#v, %v", message, err)
	}
}

func TestTerminalHistoryStateDirectory(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	for _, override := range []string{"", "relative/state", t.TempDir()} {
		t.Run(override, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("XDG_STATE_HOME", override)
			user := identity.User{Home: home, Shell: "/bin/sh"}
			id := strings.Repeat("a", 24)
			request := Request{Operation: "terminal-history", Instance: "state-test", Path: id, Content: "retained input"}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, err := Run(ctx, user, request); err != nil {
				t.Fatal(err)
			}
			base := override
			if !filepath.IsAbs(base) {
				base = filepath.Join(home, ".local", "state")
			}
			folder := filepath.Join(base, "tuxee", "terminals", id)
			data, err := os.ReadFile(filepath.Join(folder, "input-history.json"))
			if err != nil || string(data) != `["retained input"]` {
				t.Fatalf("history outside the expected state directory: %s, %v", data, err)
			}
			if _, err := os.Stat(filepath.Join(home, ".config", "tuxee", "terminals")); !os.IsNotExist(err) {
				t.Fatalf("terminal history created config state: %v", err)
			}
			if _, err := Run(ctx, user, Request{Operation: "terminal-prune", Instance: "state-test"}); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(folder); !os.IsNotExist(err) {
				t.Fatalf("cleanup missed the state directory: %v", err)
			}
		})
	}
}
