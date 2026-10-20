package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/mod/semver"
	"golang.org/x/sys/unix"
)

const InstallPath = "/usr/local/lib/tuxee/tuxee"
const CommandPath = "/usr/local/bin/tuxee"

// Bootstrap copies its own verified inode, never a mutable download pathname.
const Self = "/proc/self/exe"

func checksum(data, name string) (string, error) {
	found := ""
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[1] != name {
			continue
		}
		if found != "" {
			return "", errors.New("duplicate release checksum")
		}
		raw, err := hex.DecodeString(fields[0])
		if err != nil || len(raw) != sha256.Size {
			return "", errors.New("invalid release checksum")
		}
		found = strings.ToLower(fields[0])
	}
	if found == "" {
		return "", errors.New("release checksum is missing")
	}
	return found, nil
}

func InstalledVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C"}
	cmd.WaitDelay = time.Second
	var output limitedOutput
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("binary cannot run here (check glibc and PAM): %w: %s", err, strings.TrimSpace(output.String()))
	}
	value := strings.TrimSpace(output.String())
	if !strings.HasPrefix(value, "Tuxee ") {
		return "", errors.New("unexpected executable version response")
	}
	version := strings.TrimPrefix(value, "Tuxee ")
	if !semver.IsValid("v" + strings.TrimPrefix(version, "v")) {
		return "", errors.New("unrecognized installed version; install a stable release explicitly")
	}
	return version, nil
}

type limitedOutput struct{ bytes.Buffer }

func (b *limitedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := 4096 - b.Len(); remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(n, remaining)])
	}
	return n, nil
}

// LockDirectory serializes installers, service registration and updates.
func LockDirectory(dir string) (*os.File, error) {
	fd, err := unix.Open(filepath.Join(dir, ".tuxee-update.lock"), unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "update lock")
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another Tuxee installation or update is in progress")
	}
	return f, nil
}

// replace requires the directory lock. Only the final rename changes the target.
func replace(ctx context.Context, target, version string, write func(*os.File) error) error {
	var owner *syscall.Stat_t
	if info, err := os.Lstat(target); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("installation target must be a regular file")
		}
		owner = info.Sys().(*syscall.Stat_t)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(target), ".tuxee-stage-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = write(f); err != nil {
		return err
	}
	if owner != nil && os.Geteuid() == 0 {
		if err = f.Chown(int(owner.Uid), int(owner.Gid)); err != nil {
			return err
		}
	}
	if err = f.Chmod(0755); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	got, err := InstalledVersion(ctx, f.Name())
	if err != nil {
		return err
	}
	if got != strings.TrimPrefix(version, "v") {
		return fmt.Errorf("downloaded binary reports %q, expected %q", got, version)
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), target); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(target))
	if err != nil {
		return fmt.Errorf("binary replaced, but cannot open directory for sync: %w", err)
	}
	defer dir.Close()
	if err = dir.Sync(); err != nil {
		return fmt.Errorf("binary replaced, but directory sync failed: %w", err)
	}
	return nil
}

func (c *Client) Apply(ctx context.Context, release Release, target string) (bool, error) {
	if !ValidTag(release.Tag) || release.Draft || release.Prerelease {
		return false, errors.New("invalid stable release")
	}
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return false, errors.New("prebuilt updates support Linux amd64 and arm64")
	}
	target, err := filepath.EvalSymlinks(target)
	if err != nil {
		return false, err
	}
	lock, err := LockDirectory(filepath.Dir(target))
	if err != nil {
		return false, fmt.Errorf("cannot update %s: %w", target, err)
	}
	defer lock.Close()
	current, err := InstalledVersion(ctx, target)
	if err != nil {
		return false, err
	}
	if !Newer(release.Tag, current) {
		return false, nil
	}
	name := "tuxee-linux-" + runtime.GOARCH
	base := c.downloadBase + release.Tag + "/"
	var sums strings.Builder
	if err = c.download(ctx, base+"checksums.txt", &sums, 1<<20); err != nil {
		return false, err
	}
	expected, err := checksum(sums.String(), name)
	if err != nil {
		return false, err
	}
	err = replace(ctx, target, release.Tag, func(f *os.File) error {
		hash := sha256.New()
		if err := c.download(ctx, base+name, io.MultiWriter(f, hash), 128<<20); err != nil {
			return err
		}
		if hex.EncodeToString(hash.Sum(nil)) != expected {
			return errors.New("release checksum mismatch; installation unchanged")
		}
		return nil
	})
	return err == nil, err
}

func isTuxee(path string) bool {
	info, err := buildinfo.ReadFile(path)
	return err == nil && info.Path == "tuxee/cmd/tuxee"
}

// Bootstrap is called only by the checksum-verified installer binary.
func Bootstrap(ctx context.Context, version string) error {
	if os.Geteuid() != 0 {
		return errors.New("installation requires root; run the installer with sudo sh")
	}
	if !ValidTag("v" + version) {
		return errors.New("installation requires a stable release binary")
	}
	return bootstrap(ctx, Self, InstallPath, CommandPath, version)
}

func bootstrap(ctx context.Context, source, target, command, version string) error {
	for _, dir := range []string{filepath.Dir(target), filepath.Dir(command)} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
		info, err := os.Lstat(dir)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode().Perm()&0022 != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
			return fmt.Errorf("unsafe installation directory %s", dir)
		}
	}
	lock, err := LockDirectory(filepath.Dir(target))
	if err != nil {
		return err
	}
	defer lock.Close()
	for _, path := range []string{target, command} {
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if path == command && info.Mode()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err == nil && link == target {
				continue
			}
		}
		if !info.Mode().IsRegular() || !isTuxee(path) {
			return fmt.Errorf("refusing to replace unrelated file %s", path)
		}
	}
	// Stage the PATH link first so an unwritable bin directory preserves the binary.
	tmp, err := os.CreateTemp(filepath.Dir(command), ".tuxee-link-*")
	if err != nil {
		return err
	}
	tmp.Close()
	os.Remove(tmp.Name())
	defer os.Remove(tmp.Name())
	if err = os.Symlink(target, tmp.Name()); err != nil {
		return err
	}
	if err = replace(ctx, target, version, func(f *os.File) error {
		in, err := os.Open(source)
		if err != nil {
			return err
		}
		defer in.Close()
		_, err = io.Copy(f, in)
		return err
	}); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), command); err != nil {
		return fmt.Errorf("installed %s, but could not publish %s: %w", target, command, err)
	}
	return nil
}
