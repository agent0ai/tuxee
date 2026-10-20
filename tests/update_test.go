package tests

import (
	"bufio"
	"bytes"
	"encoding/json"
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

func TestRunningServerKeepsHelpersAfterBinaryReplacement(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("requires root and TUXEE_SYSTEM_TEST=1")
	}
	password := testPassword(t, "tuxee-poc-system")
	dir := t.TempDir()
	path := filepath.Join(dir, "tuxee")
	source, err := os.Open("../bin/tuxee")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	target, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0755)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(target, source)
	target.Close()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(path, "serve", "--http", "--bind", "127.0.0.1:0", "--state", filepath.Join(dir, "state"))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cmd.Process.Kill()
			<-done
		}
	})
	address := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			for _, word := range strings.Fields(scanner.Text()) {
				if strings.HasPrefix(word, "http://") {
					select {
					case address <- word:
					default:
					}
				}
			}
		}
	}()
	var base string
	select {
	case base = <-address:
	case <-time.After(10 * time.Second):
		t.Fatal("startup timed out")
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	request := func(path, method string, body any, csrf string) *http.Response {
		t.Helper()
		data, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(data))
		req.Header.Set("X-Tuxee-Client", "web")
		req.Header.Set("X-Tuxee-CSRF", csrf)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			content, _ := io.ReadAll(resp.Body)
			t.Fatalf("%s: %d %s", path, resp.StatusCode, content)
		}
		return resp
	}
	login := func() string {
		request("/api/login", "POST", map[string]string{"username": "tuxee-poc-system", "password": password}, "").Body.Close()
		resp := request("/api/me", "GET", nil, "")
		defer resp.Body.Close()
		var me struct {
			CSRF string `json:"csrf"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
			t.Fatal(err)
		}
		return me.CSRF
	}
	csrf := login()
	resp := request("/api/terminals", "POST", map[string]any{"name": "update regression", "columns": 80, "rows": 24}, csrf)
	var terminal struct {
		ID  string `json:"id"`
		PID int    `json:"pid"`
	}
	json.NewDecoder(resp.Body).Decode(&terminal)
	resp.Body.Close()
	// Deliberately incompatible pathname: helpers must execute the old running inode.
	next := filepath.Join(dir, "replacement")
	if err := os.WriteFile(next, []byte("#!/bin/sh\nexit 99\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(next, path); err != nil {
		t.Fatal(err)
	}
	request("/api/logout", "POST", nil, csrf).Body.Close()
	csrf = login() // exercises both PAM and the settings file helper after replacement
	request("/api/files", "POST", map[string]string{"operation": "list", "path": "/"}, csrf).Body.Close()
	resp = request("/api/terminals", "GET", nil, "")
	var sessions []struct {
		ID  string `json:"id"`
		PID int    `json:"pid"`
	}
	json.NewDecoder(resp.Body).Decode(&sessions)
	resp.Body.Close()
	if len(sessions) != 1 || sessions[0].ID != terminal.ID || sessions[0].PID != terminal.PID {
		t.Fatal("update lost retained terminal", sessions)
	}
	request("/api/terminals/"+terminal.ID, "DELETE", nil, csrf).Body.Close()
}
