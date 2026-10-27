package terminal

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"tuxee/internal/identity"
)

func TestShellPrompt(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-switching integration requires root")
	}
	for _, shell := range []string{"bash", "zsh", "fish"} {
		if _, err := exec.LookPath(shell); err != nil {
			t.Run(shell, func(t *testing.T) { t.Skipf("%s is not installed", shell) })
			continue
		}
		for _, enabled := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%t", shell, enabled), func(t *testing.T) {
				home, err := os.MkdirTemp("", "tuxee-prompt-user-*")
				if err != nil {
					t.Fatal(err)
				}
				defer os.RemoveAll(home)
				user := identity.User{Name: "nobody", UID: 65534, GID: 65534, Home: home, Shell: "/bin/sh"}
				if err := os.Chown(home, 65534, 65534); err != nil {
					t.Fatal(err)
				}
				profiles := map[string]string{
					".bash_profile":            "PROFILE_LOADED=yes\nsource ~/.bashrc\n",
					".bashrc":                  "RC_LOADED=yes\nPS1='SYSTEM> '\nPROMPT_COMMAND=': existing-hook'\n",
					".zprofile":                "PROFILE_LOADED=yes\n",
					".zshrc":                   "RC_LOADED=yes\nPROMPT='SYSTEM> '\n",
					".config/fish/config.fish": "set -g PROFILE_LOADED yes\nset -g RC_LOADED yes\nfunction fish_prompt; printf 'SYSTEM> '; end\n",
				}
				for name, data := range profiles {
					path := filepath.Join(home, name)
					if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte(data), 0644); err != nil {
						t.Fatal(err)
					}
				}
				m := NewManager()
				defer m.Close()
				selected := shell
				if shell == "bash" {
					selected = `'/bin/bash' --login`
				}
				mask := syscall.Umask(0077)
				s, err := m.Create(user, home, "prompt", 80, 24, "", "", "", selected, enabled)
				syscall.Umask(mask)
				if err != nil {
					t.Fatal(err)
				}
				a, err := s.Attach(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				defer a.Close()
				pid := "$$"
				prompt := `printf '%s' "${PS1@P}"`
				if shell == "zsh" {
					prompt = `print -rnP -- "$PROMPT"`
				} else if shell == "fish" {
					pid, prompt = "$fish_pid", "fish_prompt"
				}
				input := fmt.Sprintf("printf '%%s\\n' %s \"$PROFILE_LOADED\" \"$RC_LOADED\" \"$SHELL\" > identity\n%s > prompt\nexit\n", pid, prompt)
				if err := a.Write(context.Background(), []byte(input)); err != nil {
					t.Fatal(err)
				}
				select {
				case <-s.exited:
				case <-time.After(10 * time.Second):
					t.Fatal("shell did not finish")
				}
				if enabled {
					if _, err := os.Stat(s.cmd.Args[len(s.cmd.Args)-1]); !os.IsNotExist(err) {
						t.Fatal("prompt scripts were not cleaned up")
					}
				}
				data, err := os.ReadFile(filepath.Join(home, "identity"))
				if err != nil {
					t.Fatal(err)
				}
				lines := strings.Split(strings.TrimSpace(string(data)), "\n")
				if len(lines) != 4 || lines[0] != strconv.Itoa(s.Info().PID) || lines[1] != "yes" || lines[2] != "yes" || filepath.Base(lines[3]) != shell {
					t.Fatalf("startup files, selected shell or PID changed: %q", data)
				}
				data, err = os.ReadFile(filepath.Join(home, "prompt"))
				if err != nil {
					t.Fatal(err)
				}
				if enabled && (!strings.Contains(string(data), "❯ ") || strings.Contains(string(data), "SYSTEM>")) || !enabled && string(data) != "SYSTEM> " {
					t.Fatalf("unexpected prompt: %q", data)
				}
				for name, expected := range profiles {
					data, err := os.ReadFile(filepath.Join(home, name))
					if err != nil || string(data) != expected {
						t.Fatalf("user startup file changed: %s: %v", name, err)
					}
				}
			})
		}
	}
}

func TestPromptLengthsAndLiteralNames(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "fish"} {
		if _, err := exec.LookPath(shell); err != nil {
			t.Run(shell, func(t *testing.T) { t.Skipf("%s is not installed", shell) })
			continue
		}
		for _, environment := range []string{"1234567890123456", "12345678901234567", "123456789012345678", "é234567890123456", "$(touch PWN)%F{red}"} {
			t.Run(shell+"/"+environment, func(t *testing.T) {
				home := t.TempDir()
				path, err := filepath.Abs("prompt." + shell)
				if err != nil {
					t.Fatal(err)
				}
				command := `source "$1"; _tuxee_prompt; printf '%s' "${PS1@P}"`
				args := []string{"--noprofile", "--norc", "-ic", command, "prompt", path}
				if shell == "zsh" {
					args = []string{"-f", "-ic", `source "$1"; _tuxee_prompt; print -rnP -- "$PROMPT"`, "prompt", path}
				} else if shell == "fish" {
					args = []string{"--no-config", "-ic", `source "$argv[1]"; fish_prompt`, path}
				}
				cmd := exec.Command(shell, args...)
				cmd.Dir = home
				cmd.Env = append(os.Environ(), "HOME="+home, "NO_COLOR=1", "TERM=xterm", "VIRTUAL_ENV=/tmp/"+environment, "CONDA_PREFIX=")
				data, err := cmd.Output()
				if err != nil {
					t.Fatalf("render failed: %v", err)
				}
				want := "~ in " + environment + " ❯ "
				if len([]rune(want)) >= 25 {
					want = "\n~ in " + environment + "\n❯ "
				}
				if strings.ReplaceAll(string(data), "\r", "") != want {
					t.Fatalf("prompt = %q, want %q", data, want)
				}
				if _, err := os.Stat(filepath.Join(home, "PWN")); !os.IsNotExist(err) {
					t.Fatal("prompt name was executed")
				}
			})
		}
	}
}
