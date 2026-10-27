package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func trashFixture(t *testing.T) (string, trashLocation) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")
	return home, trashLocation{path: filepath.Join(home, ".local/share/Trash")}
}

func trashWrite(t *testing.T, path, value string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestTrashRoundTripAndCollisions(t *testing.T) {
	home, location := trashFixture(t)
	name := "space + % # ü\n.txt"
	path := filepath.Join(home, name)
	ctx := context.Background()
	trashWrite(t, path, "first")
	first, err := moveToTrash(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("source remains", err)
	}
	trashWrite(t, path, "second")
	second, err := moveToTrash(ctx, path)
	if err != nil || second.Path == first.Path {
		t.Fatal("collision", err)
	}
	bin, err := location.open(false, true)
	if err != nil {
		t.Fatal(err)
	}
	defer bin.close()
	var response Response
	if err := bin.list(ctx, &response); err != nil || len(response.Entries) != 2 {
		t.Fatal("listing", response, err)
	}
	for _, entry := range response.Entries {
		if entry.Name != name || entry.OriginalPath != path || entry.Deleted == "" {
			t.Fatal("metadata", entry)
		}
	}
	metadata, err := os.ReadFile(fdPath(bin.info, filepath.Base(first.Path)+".trashinfo"))
	if err != nil || !strings.Contains(string(metadata), "%0A") || !strings.Contains(string(metadata), "[Trash Info]\nPath=/") {
		t.Fatal("nonstandard metadata", err)
	}
	if _, err := bin.restore(ctx, filepath.Base(first.Path)); err != nil {
		t.Fatal(err)
	}
	if _, err := bin.restore(ctx, filepath.Base(second.Path)); !errors.Is(err, os.ErrExist) {
		t.Fatal("overwrote restore collision", err)
	}
	if data, _ := os.ReadFile(path); string(data) != "first" {
		t.Fatal("original overwritten")
	}
	if data, _ := os.ReadFile(second.Path); string(data) != "second" {
		t.Fatal("trash lost on failed restore")
	}
	if err := bin.remove(filepath.Base(second.Path)); err != nil {
		t.Fatal(err)
	}
	if names, _ := os.ReadDir(filepath.Join(location.path, "info")); len(names) != 0 {
		t.Fatal("metadata not removed")
	}
}

func TestTrashExistingDesktopAndRelativePaths(t *testing.T) {
	top := t.TempDir()
	location := trashLocation{path: filepath.Join(top, ".Trash-test"), top: top}
	bin, err := location.open(true, true)
	if err != nil {
		t.Fatal(err)
	}
	defer bin.close()
	trashWrite(t, fdPath(bin.files, "desktop-file"), "desktop")
	trashWrite(t, fdPath(bin.info, "desktop-file.trashinfo"), "[Trash Info]\r\nPath=original%20name\r\nDeletionDate=2026-10-27T12:00:00\r\n")
	if path, err := bin.restore(context.Background(), "desktop-file"); err != nil || path != filepath.Join(top, "original name") {
		t.Fatal(path, err)
	}
	path := filepath.Join(top, "new file")
	trashWrite(t, path, "new")
	name, err := bin.put(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(fdPath(bin.info, name+".trashinfo"))
	if !strings.Contains(string(data), "\nPath=new%20file\n") {
		t.Fatal(string(data))
	}
	for _, value := range []string{"../escape", "%2e%2e/escape", "/", "bad%00name", "missing%", "", ".", "a/../b"} {
		trashWrite(t, fdPath(bin.info, name+".trashinfo"), "[Trash Info]\nPath="+value+"\n")
		if _, err := bin.restore(context.Background(), name); err == nil {
			t.Fatalf("accepted unsafe metadata %q", value)
		}
		if _, err := os.Lstat(fdPath(bin.files, name)); err != nil {
			t.Fatal("invalid metadata lost payload", err)
		}
	}
}

func TestTrashSymlinksEmptyAndMissingParents(t *testing.T) {
	home, location := trashFixture(t)
	dir := filepath.Join(home, "folder")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(home, "keep")
	trashWrite(t, outside, "keep")
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := moveToTrash(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(home, "symlink")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	moved, err := moveToTrash(context.Background(), link)
	if err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(moved.Path); err != nil || target != outside {
		t.Fatal("followed symlink", err)
	}
	bin, err := location.open(false, true)
	if err != nil {
		t.Fatal(err)
	}
	defer bin.close()
	trashWrite(t, fdPath(bin.files, "missing-parent"), "recover me")
	trashWrite(t, fdPath(bin.info, "missing-parent.trashinfo"), "[Trash Info]\nPath="+home+"/missing/child\n")
	if _, err := bin.restore(context.Background(), "missing-parent"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if err := bin.empty(context.Background()); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(outside); string(data) != "keep" {
		t.Fatal("empty followed a symlink")
	}
	for _, sub := range []string{"files", "info"} {
		if entries, err := os.ReadDir(filepath.Join(location.path, sub)); err != nil || len(entries) != 0 {
			t.Fatal("not empty", sub, err)
		}
	}
}

func TestTrashUnsafeLocationsAndCancellation(t *testing.T) {
	home, location := trashFixture(t)
	path := filepath.Join(home, "keep")
	trashWrite(t, path, "keep")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := moveToTrash(ctx, path); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := moveToTrash(context.Background(), location.path); err == nil {
		t.Fatal("trashed trash")
	}
	if _, err := moveToTrash(context.Background(), home); err == nil {
		t.Fatal("trashed trash ancestor")
	}
	if _, err := moveToTrash(context.Background(), "/"); err == nil {
		t.Fatal("trashed root")
	}
	if _, err := trashOperation(context.Background(), Request{Operation: "trash-delete", Path: path}); err == nil {
		t.Fatal("deleted ordinary file as trash")
	}
	if err := os.RemoveAll(location.path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(home, location.path); err != nil {
		t.Fatal(err)
	}
	if _, err := moveToTrash(context.Background(), path); err == nil {
		t.Fatal("accepted symlink trash")
	}
	if err := os.Remove(location.path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(location.path, 0777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(location.path, 0777); err != nil {
		t.Fatal(err)
	}
	if _, err := moveToTrash(context.Background(), path); err == nil {
		t.Fatal("accepted public trash")
	}
	if data, _ := os.ReadFile(path); string(data) != "keep" {
		t.Fatal("failure lost source")
	}
}

func TestTrashMountsXDGAndLocks(t *testing.T) {
	home, _ := trashFixture(t)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "custom"))
	location, err := homeTrash()
	if err != nil || location.path != filepath.Join(home, "custom/Trash") {
		t.Fatal(location, err)
	}
	path := filepath.Join(home, "keep")
	trashWrite(t, path, "keep")
	if _, err := moveToTrash(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	first, err := location.open(false, false)
	if err != nil {
		t.Fatal(err)
	}
	defer first.close()
	second, err := location.open(false, false)
	if err != nil {
		t.Fatal("concurrent readers", err)
	}
	second.close()
	if writer, err := location.open(false, true); err == nil {
		writer.close()
		t.Fatal("writer ignored reader lock")
	}
	if got := trashMount("/disk/a/file", []string{"/", "/disk", "/disk/a", "/disk/ab"}); got != "/disk/a" {
		t.Fatal(got)
	}
	shared := filepath.Join(home, ".Trash")
	if err := os.Mkdir(shared, 0777); err != nil {
		t.Fatal(err)
	}
	if got := volumeTrash(home); len(got) != 1 {
		t.Fatal("accepted shared trash without sticky bit")
	}
	if err := os.Chmod(shared, os.ModeSticky|0777); err != nil {
		t.Fatal(err)
	}
	if got := volumeTrash(home); len(got) != 2 {
		t.Fatal("ignored shared trash")
	}
	if err := os.Remove(shared); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(home, shared); err != nil {
		t.Fatal(err)
	}
	if got := volumeTrash(home); len(got) != 1 {
		t.Fatal("accepted shared trash symlink")
	}
	// Metadata must never block on a FIFO or follow an external symlink.
	if err := unix.Mkfifo(fdPath(first.info, "fifo.trashinfo"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := first.original("fifo"); err == nil {
		t.Fatal("accepted metadata FIFO")
	}
	if err := os.Symlink(path, fdPath(first.info, "link.trashinfo")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := first.original("link"); err == nil {
		t.Fatal("accepted metadata symlink")
	}
}

func TestTrashReusesExistingVolumeBin(t *testing.T) {
	top := t.TempDir()
	fallback := volumeTrash(top)[0]
	bin, err := fallback.open(true, true)
	if err != nil {
		t.Fatal(err)
	}
	bin.close()
	shared := filepath.Join(top, ".Trash")
	if err := os.Mkdir(shared, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(shared, os.ModeSticky|0777); err != nil {
		t.Fatal(err)
	}
	bin, err = openVolumeTrash(top)
	if err != nil {
		t.Fatal(err)
	}
	defer bin.close()
	if bin.path != fallback.path {
		t.Fatal("created another bin instead of reusing existing trash", bin.path)
	}
	if entries, err := os.ReadDir(shared); err != nil || len(entries) != 0 {
		t.Fatal("unexpected shared bin", err)
	}
}
