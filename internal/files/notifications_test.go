package files

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNotificationDeliveryAndDismissal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	var version string
	run := func(operation, id string, notice *Notification) Response {
		t.Helper()
		result, err := notificationOperation(t.Context(), Request{
			Operation: "notification-" + operation, Path: id, Notice: notice, Version: version,
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	dir := filepath.Join(state, "tuxee", "notifications")
	update := Notification{Type: "info", Release: "v99.1.0"}
	run("broadcast", "", &update)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("broadcast should skip an account without Tuxee configuration", err)
	}
	warning := Notification{Type: "warning", Text: "**Maintenance**"}
	run("post", "", &warning)
	run("broadcast", "", &update)
	if list := run("list", "", nil).Inbox; list.Count != 1 {
		t.Fatal("a targeted notice alone must not make a recipient eligible for broadcasts", list)
	}
	if err := os.MkdirAll(filepath.Join(home, ".config", "tuxee"), 0700); err != nil {
		t.Fatal(err)
	}
	run("broadcast", "", &update)
	run("broadcast", "", &update)
	result := run("list", "", nil).Inbox
	if result.Count != 2 || result.Items[0].Release != update.Release || result.Items[1].Text != warning.Text {
		t.Fatal(result)
	}
	release, id := result.Items[0].ID, result.Items[1].ID
	if info, err := os.Stat(filepath.Join(dir, release+".json")); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("notification must be private", info, err)
	}
	run("dismiss", release, nil)
	if _, err := os.Stat(filepath.Join(dir, release+".json")); !os.IsNotExist(err) {
		t.Fatal("dismiss must delete the message file", err)
	}
	run("broadcast", "", &update)
	if list := run("list", "", nil).Inbox; list.Count != 1 {
		t.Fatal("dismissed release must stay dismissed", list)
	}
	if err := os.Symlink(filepath.Join(dir, id+".json"), filepath.Join(dir, strings.Repeat("b", 32)+".json")); err != nil {
		t.Fatal(err)
	}
	if list := run("list", "", nil).Inbox; list.Count != 1 {
		t.Fatal("list must skip symlinks", list)
	}
	run("dismiss", strings.Repeat("b", 32), nil)
	if _, err := os.Lstat(filepath.Join(dir, strings.Repeat("b", 32)+".json")); err != nil {
		t.Fatal("dismiss must leave unrelated entries alone", err)
	}
	if _, err := notificationOperation(t.Context(), Request{Operation: "notification-dismiss", Path: "../settings"}); err == nil {
		t.Fatal("dismiss accepted a path")
	}
	update.Release = "v99.2.0"
	for range 65 {
		run("post", "", &warning)
	}
	run("post", "", &update)
	if list := run("list", "", nil).Inbox; list.Count <= len(list.Items) {
		t.Fatal("expected overflow")
	}
	version = "v99.2.0"
	if list := run("list", "", nil).Inbox; list.Count != 66 || len(list.Items) != 64 || list.Items[0].Release != "" {
		t.Fatal("installed release should be excluded before counting and limiting the page")
	}
	run("dismiss-all", "", nil)
	if list := run("list", "", nil).Inbox; list.Count != 0 {
		t.Fatal("all visible notices should be dismissed", list)
	}
	version = "99.1.0"
	if list := run("list", "", nil).Inbox; list.Count != 1 || list.Items[0].Release != update.Release {
		t.Fatal("an older instance sharing the account should still see the release", list)
	}
	run("dismiss-all", "", nil)
	run("post", "", &update)
	if list := run("list", "", nil).Inbox; list.Count != 0 {
		t.Fatal(list)
	}
	if _, err := os.Lstat(filepath.Join(dir, strings.Repeat("b", 32)+".json")); err != nil {
		t.Fatal(err)
	}

}
