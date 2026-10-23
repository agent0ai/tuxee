package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/creack/pty"
)

func TestMain(m *testing.M) {
	// The updater probes a disposable copy of this test executable with "version".
	if len(os.Args) == 2 && os.Args[1] == "version" {
		_ = run([]string{"version"})
		return
	}
	os.Exit(m.Run())
}

type releaseTransport func(*http.Request) (*http.Response, error)

func (f releaseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestUpdateOutputHelper(t *testing.T) {
	mode := os.Getenv("TUXEE_CLI_FIXTURE")
	if mode == "" {
		return
	}
	binary := "#!/bin/sh\nprintf 'Tuxee 0.0.1\\n'\n"
	http.DefaultTransport = releaseTransport(func(r *http.Request) (*http.Response, error) {
		body, status := binary, 200
		switch {
		case strings.HasSuffix(r.URL.Path, "/latest"):
			body = `{"tag_name":"v0.0.1"}`
			if mode == "current" {
				body = `{"tag_name":"v0.0.0"}`
			}
			if mode == "failure" {
				status = 503
			}
		case strings.HasSuffix(r.URL.Path, "/checksums.txt"):
			body = fmt.Sprintf("%x  tuxee-linux-%s\n", sha256.Sum256([]byte(binary)), runtime.GOARCH)
			if mode == "checksum" {
				body = strings.Repeat("0", 64) + "  tuxee-linux-" + runtime.GOARCH + "\n"
			}
		case strings.HasSuffix(r.URL.Path, "/tuxee-linux-"+runtime.GOARCH):
		default:
			t.Fatalf("unexpected fixture request: %s", r.URL)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	if err := run([]string{"update"}); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func TestUpdateConsole(t *testing.T) {
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	transcripts := map[string]string{}
	for _, tc := range []struct {
		mode, want string
		tty, match bool
		failed     bool
	}{
		{"success", "Successfully updated Tuxee to v0.0.1.", true, true, false},
		{"success", "Successfully updated Tuxee to v0.0.1.", false, false, false},
		{"current", "Tuxee is up to date; installation unchanged.", true, true, false},
		{"failure", "Update failed: GitHub download returned HTTP 503", true, true, true},
		{"checksum", "Update failed:", false, true, true},
	} {
		t.Run(fmt.Sprintf("%s/tty=%t/match=%t", tc.mode, tc.tty, tc.match), func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "tuxee")
			in, err := os.Open(source)
			if err != nil {
				t.Fatal(err)
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY, 0755)
			if err != nil {
				in.Close()
				t.Fatal(err)
			}
			_, err = io.Copy(out, in)
			in.Close()
			out.Close()
			if err != nil {
				t.Fatal(err)
			}
			path := "/usr/bin:/bin"
			command := "'" + target + "' restart"
			if tc.match {
				path = dir + ":" + path
				command = "tuxee restart"
			}
			if os.Geteuid() != 0 {
				command = "sudo " + command
			}
			cmd := exec.Command(target, "-test.run=^TestUpdateOutputHelper$")
			cmd.Env = append(os.Environ(), "TUXEE_CLI_FIXTURE="+tc.mode, "PATH="+path, "TERM=xterm-256color", "NO_COLOR=")
			var data []byte
			if tc.tty {
				terminal, startErr := pty.Start(cmd)
				if startErr != nil {
					t.Fatal(startErr)
				}
				data, _ = io.ReadAll(terminal)
				terminal.Close()
				err = cmd.Wait()
			} else {
				data, err = cmd.CombinedOutput()
			}
			text := strings.ReplaceAll(string(data), "\r\n", "\n")
			if (err != nil) != tc.failed || !strings.Contains(text, tc.want) {
				t.Fatalf("%v\n%s", err, text)
			}
			color := "32"
			if tc.failed {
				color = "31"
			}
			if tc.tty {
				if !strings.Contains(text, "\n\x1b["+color+"m"+tc.want) || !strings.Contains(text, "Restart using: \x1b[33m"+command+"\x1b[0m") {
					t.Fatalf("missing colors: %q", text)
				}
			} else if strings.Contains(text, "\x1b[") || !strings.Contains(text, "Restart using: "+command) {
				t.Fatalf("bad plain output: %q", text)
			}
			if !strings.Contains(text, "\n\nChanges take effect after restarting Tuxee, which kills all running terminals.\n") {
				t.Fatal("missing spacing/disclaimer", text)
			}
			installed, readErr := os.ReadFile(target)
			if readErr != nil || strings.HasPrefix(string(installed), "#!/bin/sh") != (tc.mode == "success") {
				t.Fatal("wrong replacement outcome", readErr)
			}
			transcripts[fmt.Sprintf("%s-tty=%t", tc.mode, tc.tty)] = text
		})
	}
	if path := os.Getenv("TUXEE_CLI_TRANSCRIPTS"); path != "" {
		data, _ := json.MarshalIndent(transcripts, "", "  ")
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}
	}
}
