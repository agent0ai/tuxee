package files

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResetConfigurationMovesConfigAndStateToBackup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	write := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	config := filepath.Join(home, ".config", "tuxee")
	state := filepath.Join(home, ".local", "state", "tuxee")
	write(filepath.Join(config, "settings.json"), `{"broken":`)
	write(filepath.Join(state, "notifications", "n.json"), `{}`)
	write(filepath.Join(state, "editors", "a", "session.json"), `{}`)
	write(filepath.Join(state, "terminals", "000000000000000000000001", "meta.json"), `{}`)
	write(filepath.Join(state, "terminals", "000000000000000000000002", "meta.json"), `{}`)
	write(filepath.Join(home, "notes.txt"), "user file")
	// A live guardian (possibly another installation's) holds this folder.
	live, err := lockTerminalDirectory(filepath.Join(state, "terminals", "000000000000000000000002"))
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()

	response, _, err := execute(t.Context(), Request{Operation: "config-reset"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	backup := response.Path
	if filepath.Dir(backup) != filepath.Join(home, ResetBackupDirectory) {
		t.Fatalf("backup %q is not under ~/%s", backup, ResetBackupDirectory)
	}
	for _, path := range []string{
		"config/settings.json", "state/notifications/n.json", "state/editors/a/session.json",
		"state/terminals/000000000000000000000001/meta.json",
	} {
		if _, err := os.Stat(filepath.Join(backup, path)); err != nil {
			t.Fatal("backup is missing", path, err)
		}
	}
	if _, err := os.Stat(filepath.Join(state, "terminals", "000000000000000000000002", "meta.json")); err != nil {
		t.Fatal("a guardian-locked terminal folder must stay in place", err)
	}
	for _, path := range []string{filepath.Join(state, "notifications"), filepath.Join(state, "editors"), filepath.Join(config, "settings.json")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("reset left", path, err)
		}
	}
	if info, err := os.Stat(config); err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		t.Fatal("reset must recreate a private configuration folder", info, err)
	}
	if data, err := os.ReadFile(filepath.Join(home, "notes.txt")); err != nil || string(data) != "user file" {
		t.Fatal("reset touched user files", err)
	}
	var meta ResetBackup
	data, err := os.ReadFile(filepath.Join(backup, "backup.json"))
	if err == nil {
		err = json.Unmarshal(data, &meta)
	}
	if err != nil || meta.Config != config || meta.State != state || meta.Created == "" {
		t.Fatal("backup metadata", string(data), err)
	}
	if info, err := os.Stat(backup); err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("backup must be private", err)
	}

	// A second reset in the same second gets its own folder, even without saved data.
	if err := os.RemoveAll(config); err != nil {
		t.Fatal(err)
	}
	second, _, err := execute(t.Context(), Request{Operation: "config-reset"}, nil)
	if err != nil || second.Path == backup || !strings.HasPrefix(second.Path, filepath.Join(home, ResetBackupDirectory)) {
		t.Fatal("second backup", second.Path, err)
	}
}

func TestResetConfigurationHonorsStateOverride(t *testing.T) {
	home, state := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", state)
	source := filepath.Join(state, "tuxee", "notifications")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "n.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	response, _, err := execute(t.Context(), Request{Operation: "config-reset"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(response.Path, "state", "notifications", "n.json")); err != nil {
		t.Fatal("XDG_STATE_HOME state was not backed up", err)
	}
}
