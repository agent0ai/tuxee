package terminal

import (
	"context"
	"embed"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"tuxee/internal/identity"
)

//go:embed shell-launch.sh
var shellLauncher string

//go:embed shell.bashrc prompt.bash prompt.zsh prompt.fish shell.zshenv shell.zprofile shell.zshrc
var shellFiles embed.FS

func prepareShell(user identity.User, shell, command string, prompt bool) (*exec.Cmd, func(), error) {
	if strings.TrimSpace(shell) == "" {
		shell = "bash"
	}
	cleanup := func() {}
	directory := ""
	if prompt && command == "" {
		var err error
		directory, err = os.MkdirTemp("/tmp", "tuxee-shell-*")
		if err != nil {
			return nil, cleanup, err
		}
		cleanup = func() { os.RemoveAll(directory) }
		entries, _ := shellFiles.ReadDir(".")
		for _, entry := range entries {
			data, err := shellFiles.ReadFile(entry.Name())
			path := filepath.Join(directory, strings.Replace(entry.Name(), "shell.z", ".z", 1))
			if err == nil {
				err = os.WriteFile(path, data, 0600)
			}
			if err == nil {
				err = os.Chown(path, int(user.UID), int(user.GID))
			}
			if err != nil {
				cleanup()
				return nil, func() {}, err
			}
		}
		if err := os.Chown(directory, int(user.UID), int(user.GID)); err != nil {
			cleanup()
			return nil, func() {}, err
		}
	}
	cmd := user.Command(context.Background(), "/bin/sh", "-c", shellLauncher, "tuxee-shell", shell, command, directory)
	return cmd, cleanup, nil
}
