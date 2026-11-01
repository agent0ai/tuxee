package desktop

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"

	"tuxee/internal/identity"
)

func TestXDirectoryTrust(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root to check directory ownership")
	}
	root := t.TempDir()
	path := filepath.Join(root, "X11")
	if err := prepareXDirectory(path); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode() != os.ModeDir|os.ModeSticky|0777 {
		t.Fatal("incorrect socket directory permissions", info.Mode())
	}
	if err := prepareXDirectory(path); err != nil {
		t.Fatal("existing safe directory rejected", err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if err := prepareXDirectory(link); err == nil {
		t.Fatal("accepted socket directory symlink")
	}
	if err := os.Chmod(path, 0777); err != nil {
		t.Fatal(err)
	}
	if err := prepareXDirectory(path); err == nil {
		t.Fatal("accepted directory without sticky bit")
	}
	if err := os.Chmod(path, os.ModeSticky|0777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(path, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	if err := prepareXDirectory(path); err == nil {
		t.Fatal("accepted attacker-owned socket directory")
	}
}

func TestDisplayPreparationResistsSymlinks(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root and an unprivileged racer")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("requires Python for the unprivileged race fixture")
	}
	root, err := os.MkdirTemp("/tmp", "tuxee-display-security-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	const sentinel = "root-only sentinel; must remain unchanged"
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte(sentinel), 0600); err != nil {
		t.Fatal(err)
	}
	// Preparation only checks availability; no GUI processes need to be launched.
	if err := os.WriteFile(filepath.Join(root, "tuxee-Xvnc"), []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root)
	t.Setenv("TMPDIR", root)
	cmd := exec.Command(python, "-c", `
import os, sys
root = sys.argv[1]
print('ready', flush=True)
while True:
    for entry in os.scandir(root):
        if not entry.name.startswith('tuxee-display-'):
            continue
        for name in ('Xauthority', 'xdg'):
            path = entry.path + '/' + name
            try:
                if name == 'xdg':
                    os.rmdir(path)
                else:
                    os.unlink(path)
            except OSError:
                pass
            try:
                os.symlink(root + '/target', path)
            except OSError:
                pass
`, root)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{65534}}}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatal("racer did not start", err)
	}
	for range 100 {
		display, err := Prepare(identity.User{UID: 65534, GID: 65534})
		if err != nil || display == nil {
			t.Fatal("prepare", err)
		}
		display.Close()
		data, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(data, []byte(sentinel)) || info.Sys().(*syscall.Stat_t).Uid != 0 || info.Mode().Perm() != 0600 {
			t.Fatal("root target changed during display preparation")
		}
	}
}
