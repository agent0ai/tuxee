package files

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestPermissionsBatch(t *testing.T) {
	dir := t.TempDir()
	first, second := filepath.Join(dir, "first"), filepath.Join(dir, "second")
	link := filepath.Join(dir, "link")
	for _, path := range []string{first, second} {
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := unix.Chmod(first, 01604); err != nil {
		t.Fatal(err)
	}
	if err := unix.Chmod(second, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(second, link); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	change := &AccessChange{Mask: 0004}
	response, _, err := execute(ctx, Request{Operation: "permissions", Paths: []string{first, link, second}, Access: change}, nil)
	if err != nil || len(response.Results) != 2 || response.Results[0].Error != "" || response.Results[1].Error == "" {
		t.Fatalf("expected one edit and one failure: %+v, %v", response.Results, err)
	}
	for path, want := range map[string]string{first: "1600", second: "0644"} {
		response, _, err := execute(ctx, Request{Operation: "stat", Path: path}, nil)
		if err != nil || response.Entry.Mode != want {
			t.Fatalf("%s: %+v, %v", path, response.Entry, err)
		}
	}
	if _, _, err := execute(ctx, Request{Operation: "permissions", Path: first, Access: &AccessChange{Mask: 04000}}, nil); err == nil {
		t.Fatal("unrecognized permission bits accepted")
	}
}

func TestPermissionsOwnership(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("ownership transfer requires root")
	}
	account, err := user.Lookup("nobody")
	if err != nil {
		t.Skip(err)
	}
	group, err := user.LookupGroupId(account.Gid)
	if err != nil {
		t.Skip(err)
	}
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	link := path + ".link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, _, err := execute(ctx, Request{Operation: "permissions", Path: link, Access: &AccessChange{Owner: account.Username, Group: group.Name}}, nil); err != nil {
		t.Fatal(err)
	}
	source, _, err := execute(ctx, Request{Operation: "stat", Path: path}, nil)
	if err != nil || source.Entry.UID != 0 {
		t.Fatalf("link target ownership changed: %+v, %v", source.Entry, err)
	}
	result, _, err := execute(ctx, Request{Operation: "stat", Path: link}, nil)
	if err != nil || result.Entry.Owner != account.Username || result.Entry.Group != group.Name {
		t.Fatalf("link ownership: %+v, %v", result.Entry, err)
	}
}
