package audio

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
	"tuxee/internal/keeper"
)

func cleanupName(instance string) string {
	return fmt.Sprintf("keeper-%x", sha256.Sum256([]byte(instance)))
}

func retainCleanup(dir, instance string, owner *keeper.Client) error {
	f, err := os.OpenFile(filepath.Join(dir, cleanupName(instance)), os.O_CREATE|os.O_EXCL|os.O_RDONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return err
	}
	return owner.Put(3, f)
}

// The guardian's lock also covers a server outage. Reclaim only private,
// server-owned directories of this installation after that lock is released.
func cleanupOrphans(instance string) {
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "tuxee-audio-*"))
	for _, dir := range dirs {
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0022 != 0 {
			continue
		}
		root, err := os.OpenRoot(dir)
		if err != nil {
			continue
		}
		f, err := root.OpenFile(cleanupName(instance), os.O_RDONLY|unix.O_NOFOLLOW, 0)
		root.Close()
		if err != nil {
			continue
		}
		st, err := f.Stat()
		if err == nil && st.Mode().IsRegular() && st.Sys().(*syscall.Stat_t).Uid == uint32(os.Geteuid()) && unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB) == nil {
			_ = os.RemoveAll(dir)
		}
		f.Close()
	}
}
