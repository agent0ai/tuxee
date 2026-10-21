package update

import (
	"context"
	_ "embed"
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
)

//go:embed update.sh
var setupScript string

// Setup runs the release's container migration before accepting connections.
// The marker belongs to the container's writable layer, not a persisted volume.
func Setup(ctx context.Context, version string, output io.Writer) error {
	if _, err := os.Stat("/opt/tuxee/entrypoint.sh"); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return setup(ctx, version, filepath.Dir(InstallPath), setupScript, output)
}

func setup(ctx context.Context, version, directory, script string, output io.Writer) error {
	version = strings.TrimPrefix(version, "v")
	if version == "0.0.0" || !ValidTag("v"+version) {
		return nil
	}
	marker := filepath.Join(directory, "update-version")
	completed, err := os.ReadFile(marker)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	previous := strings.TrimSpace(string(completed))
	if ValidTag("v"+previous) && !Newer("v"+version, previous) {
		return nil
	}
	lock, err := LockDirectory(directory)
	if err != nil {
		return err
	}
	defer lock.Close()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	temporary, err := os.MkdirTemp("", "tuxee-setup-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	fmt.Fprintf(output, "Tuxee %s: preparing container runtime\n", version)
	cmd := exec.CommandContext(ctx, "/bin/sh", "-s", "--", version, runtime.GOARCH)
	cmd.Env = append(os.Environ(), "TMPDIR="+temporary)
	cmd.Stdin = strings.NewReader(script)
	cmd.Stdout, cmd.Stderr = output, output
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("container setup: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename keeps an interrupted marker write eligible for retry.
	staged := marker + ".tmp"
	defer os.Remove(staged)
	if err := os.WriteFile(staged, []byte(version+"\n"), 0600); err != nil {
		return err
	}
	return os.Rename(staged, marker)
}
