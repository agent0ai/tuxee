package tests

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRuntimeStatus(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("requires root and TUXEE_SYSTEM_TEST=1")
	}
	username := "tuxee-poc-status"
	password := testPassword(t, username)
	dir, err := os.MkdirTemp("", "tuxee-status-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(dir, "tuxee")
	data, err := os.ReadFile("../bin/tuxee")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, data, 0755); err != nil {
		t.Fatal(err)
	}
	start := func(state string) (*exec.Cmd, <-chan string, func()) {
		t.Helper()
		cmd := exec.Command(executable, "serve", "--http", "--bind", "127.0.0.1:0", "--state", state, "--acme", "off")
		cmd.Env = portEnvironment("", "")
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		started := make(chan string, 4)
		go func() {
			scanner := bufio.NewScanner(stdout)
			for scanner.Scan() {
				if _, tail, ok := strings.Cut(scanner.Text(), "listening at "); ok {
					started <- strings.Fields(tail)[0]
				}
			}
		}()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		stopped := false
		stop := func() {
			if stopped {
				return
			}
			stopped = true
			cmd.Process.Signal(syscall.SIGCONT)
			cmd.Process.Signal(syscall.SIGTERM)
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("server shutdown: %v", err)
				}
			case <-time.After(15 * time.Second):
				cmd.Process.Kill()
				<-done
				t.Error("server shutdown timed out")
			}
		}
		t.Cleanup(stop)
		return cmd, started, stop
	}
	awaitStart := func(started <-chan string) string {
		t.Helper()
		select {
		case base := <-started:
			return base
		case <-time.After(15 * time.Second):
			t.Fatal("startup timed out")
			return ""
		}
	}
	state := filepath.Join(dir, "state")
	service, starts, stop := start(state)
	base := awaitStart(starts)
	status := func(user *syscall.Credential, args ...string) (string, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, executable, append([]string{"status"}, args...)...)
		cmd.Env = portEnvironment("invalid", "invalid") // Status must use live metadata, never this shell's config.
		cmd.Dir = "/"
		if user != nil {
			cmd.SysProcAttr = &syscall.SysProcAttr{Credential: user}
		}
		output, err := cmd.CombinedOutput()
		return string(output), err
	}
	check := func(want ...string) string {
		t.Helper()
		out, err := status(nil, "--state", state)
		if err != nil {
			t.Fatalf("status: %v\n%s", err, out)
		}
		for _, value := range want {
			if !strings.Contains(out, value) {
				t.Fatalf("status missing %q:\n%s", value, out)
			}
		}
		return out
	}
	check("Running", "Healthy", strings.TrimPrefix(base, "http://"), "Disabled", "0 signed-in users", "0 running", fmt.Sprint(service.Process.Pid))
	for _, credential := range []*syscall.Credential{nil, {Uid: 65534, Gid: 65534}} {
		out, err := status(credential)
		if err != nil || !strings.Contains(out, "Healthy") {
			t.Fatalf("local status: %v\n%s", err, out)
		}
		if credential != nil && (!strings.Contains(out, "requires root") || strings.Contains(out, "signed-in users")) {
			t.Fatalf("unprivileged counts leaked:\n%s", out)
		}
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	var csrf string
	api := func(path, method string, body any, expected int, result any) {
		t.Helper()
		data, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", base)
		req.Header.Set("X-Tuxee-Client", "web")
		req.Header.Set("X-Tuxee-CSRF", csrf)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != expected {
			t.Fatalf("%s: HTTP %d; want %d", path, response.StatusCode, expected)
		}
		if result != nil {
			if err := json.NewDecoder(response.Body).Decode(result); err != nil {
				t.Fatal(err)
			}
		} else {
			io.Copy(io.Discard, response.Body)
		}
	}
	login := func() {
		api("/api/login", "POST", map[string]string{"username": username, "password": password}, 200, nil)
		var me struct{ CSRF string }
		api("/api/me", "GET", nil, 200, &me)
		csrf = me.CSRF
	}
	login()
	check("1 signed-in user", "0 running")
	var terminal struct{ ID string }
	api("/api/terminals", "POST", map[string]any{"name": "Status test", "columns": 80, "rows": 24, "command": "exec sleep 300"}, 201, &terminal)
	t.Cleanup(func() {
		if terminal.ID != "" {
			login()
			api("/api/terminals/"+terminal.ID, "DELETE", nil, 200, nil)
		}
	})
	check("1 signed-in user", "1 running")
	api("/api/logout", "POST", nil, 200, nil)
	check("0 signed-in users", "1 running")
	login()
	if err := exec.Command(executable, "restart", "--state", state).Run(); err != nil {
		t.Fatal(err)
	}
	if next := awaitStart(starts); next != base {
		t.Fatalf("restart changed listener: %s -> %s", base, next)
	}
	check("0 signed-in users", "1 running", fmt.Sprint(service.Process.Pid))
	if err := service.Process.Signal(syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	before := time.Now()
	out, statusErr := status(nil, "--state", state)
	service.Process.Signal(syscall.SIGCONT)
	if statusErr == nil || !strings.Contains(out, "Unresponsive") || !strings.Contains(out, "Timeout") || !strings.Contains(out, "Unavailable") || time.Since(before) > 7*time.Second {
		t.Fatalf("stalled server status (%s): %v\n%s", time.Since(before), statusErr, out)
	}
	check("Healthy", "1 running")
	_, secondStarts, stopSecond := start(filepath.Join(dir, "other-state"))
	awaitStart(secondStarts)
	if out, err := status(nil); err == nil || !strings.Contains(out, "multiple Tuxee instances") {
		t.Fatalf("ambiguous selection: %v\n%s", err, out)
	}
	check("Healthy", "1 running")
	stopSecond()
	login()
	api("/api/terminals/"+terminal.ID, "DELETE", nil, 200, nil)
	terminal.ID = ""
	check("0 running")
	stop()
	if out, err := status(nil, "--state", state); err == nil || !strings.Contains(out, "Not running") {
		t.Fatalf("stopped status: %v\n%s", err, out)
	}
	if _, err := os.Lstat(filepath.Join("/run/tuxee", fmt.Sprintf("%d.sock", service.Process.Pid))); !os.IsNotExist(err) {
		t.Fatalf("status socket left after shutdown: %v", err)
	}
}
