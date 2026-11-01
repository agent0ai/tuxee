package update

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
)

type Request struct {
	Target string `json:"target"`
	Apply  bool   `json:"apply"`
}

type Installation struct {
	CanApply   bool          `json:"canApply"`
	CanRestart bool          `json:"canRestart"`
	Installed  string        `json:"installed,omitempty"`
	Latest     string        `json:"latest,omitempty"`
	Error      string        `json:"error,omitempty"`
	Text       *i18n.Message `json:"text,omitempty"`
}

// Check permissions in the worker, including ACLs, read-only mounts and sticky directories.
// The installer still enforces permissions at each syscall if they change after this check.
func canApply(target string) bool {
	dir := filepath.Dir(target)
	if unix.Faccessat(unix.AT_FDCWD, dir, unix.R_OK|unix.W_OK|unix.X_OK, unix.AT_EACCESS) != nil ||
		unix.Faccessat(unix.AT_FDCWD, target, unix.R_OK|unix.X_OK, unix.AT_EACCESS) != nil {
		return false
	}
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	parent, err := os.Stat(dir)
	if err != nil {
		return false
	}
	uid := uint32(os.Geteuid())
	if parent.Mode()&os.ModeSticky != 0 && uid != 0 && parent.Sys().(*syscall.Stat_t).Uid != uid && info.Sys().(*syscall.Stat_t).Uid != uid {
		return false
	}
	var fileStat, dirStat unix.Statx_t
	if unix.Statx(unix.AT_FDCWD, target, 0, unix.STATX_BASIC_STATS|unix.STATX_MNT_ID, &fileStat) == nil &&
		unix.Statx(unix.AT_FDCWD, dir, 0, unix.STATX_BASIC_STATS|unix.STATX_MNT_ID, &dirStat) == nil {
		// An individual file mount cannot be atomically replaced, even by root.
		if fileStat.Mask&dirStat.Mask&unix.STATX_MNT_ID != 0 && fileStat.Mnt_id != dirStat.Mnt_id {
			return false
		}
		if (fileStat.Attributes|dirStat.Attributes)&(unix.STATX_ATTR_IMMUTABLE|unix.STATX_ATTR_APPEND) != 0 {
			return false
		}
	}
	fd, err := unix.Open(filepath.Join(dir, ".tuxee-update.lock"), unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	if err != nil {
		return false
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	return unix.Fstat(fd, &stat) == nil && stat.Mode&unix.S_IFMT == unix.S_IFREG
}

// Worker is launched with the signed-in Linux user's credentials, never with sudo.
func Worker() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	var input Request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return err
	}
	var output Installation
	output.CanRestart = unix.Kill(os.Getppid(), 0) == nil
	target, err := filepath.EvalSymlinks(input.Target)
	if err == nil {
		output.CanApply = canApply(target)
		output.Installed, err = InstalledVersion(ctx, target)
	}
	if input.Apply {
		if !output.CanApply || !output.CanRestart {
			err = i18n.New("updates.contactAdministrator")
		} else if err == nil {
			client := NewClient()
			var release Release
			release, err = client.Latest(ctx)
			if err == nil {
				output.Latest = release.Tag
				_, err = client.Apply(ctx, release, target)
			}
			// Read the actual installation even after a late sync failure.
			output.Installed, _ = InstalledVersion(ctx, target)
		}
		if err != nil {
			output.Error, output.Text = err.Error(), i18n.Describe(err)
		}
	} else if err != nil {
		output.CanApply = false
	}
	return json.NewEncoder(os.Stdout).Encode(output)
}

func Run(ctx context.Context, user identity.User, input Request) (Installation, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	data, err := json.Marshal(input)
	if err != nil {
		return Installation{}, err
	}
	cmd := user.Command(ctx, identity.Self, "__update")
	cmd.Dir = "/"
	cmd.Stdin = bytes.NewReader(data)
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = time.Second
	var stdout limitedOutput
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return Installation{}, err
	}
	var output Installation
	err = json.Unmarshal(stdout.Bytes(), &output)
	return output, err
}
