package audio

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestOrphanCleanupRespectsGuardianLock(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	dir, err := os.MkdirTemp("", "tuxee-audio-")
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(dir, cleanupName("one")))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	cleanupOrphans("one")
	if _, err = os.Stat(dir); err != nil {
		t.Fatal("removed active runtime", err)
	}
	f.Close()
	cleanupOrphans("two")
	if _, err = os.Stat(dir); err != nil {
		t.Fatal("removed another instance", err)
	}
	cleanupOrphans("one")
	if _, err = os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("orphan survived", err)
	}
}
