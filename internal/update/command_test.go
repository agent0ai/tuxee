package update

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCommandResolvesInstallation(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "installed tux'ee")
	link := filepath.Join(dir, "tuxee")
	write := func(path string) {
		t.Helper()
		if err := os.WriteFile(path, []byte("binary"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	write(target)
	t.Setenv("PATH", dir)
	want := "'" + dir + "/installed tux'\\''ee'"
	if got := Command(target); got != want {
		t.Fatal("missing command", got)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if got := Command(target); got != "tuxee" {
		t.Fatal("matching symlink", got)
	}
	write(target + ".new")
	if err := os.Rename(target+".new", target); err != nil {
		t.Fatal(err)
	}
	if got := Command(target); got != "tuxee" {
		t.Fatal("atomic replacement", got)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	write(link)
	if got := Command(target); got != want {
		t.Fatal("different installation", got)
	}
	t.Setenv("PATH", ".")
	if got := Command(target); got != want {
		t.Fatal("unsafe relative lookup", got)
	}
}
