package tests

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func portEnvironment(httpPort, httpsPort string) []string {
	var env []string
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "TUXEE_HTTP_PORT=") && !strings.HasPrefix(item, "TUXEE_HTTPS_PORT=") {
			env = append(env, item)
		}
	}
	if httpPort != "" {
		env = append(env, "TUXEE_HTTP_PORT="+httpPort)
	}
	if httpsPort != "" {
		env = append(env, "TUXEE_HTTPS_PORT="+httpsPort)
	}
	return env
}

func reservePort(t *testing.T, port string) net.Listener {
	t.Helper()
	l, err := net.Listen("tcp", ":"+port)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return l
}

// Inspect only this child process's TCP listeners, including unexpected ephemeral ports.
func processPorts(t *testing.T, pid int) []int {
	t.Helper()
	sockets := map[string]bool{}
	entries, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		target, _ := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", pid, entry.Name()))
		if strings.HasPrefix(target, "socket:[") {
			sockets[strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")] = true
		}
	}
	var ports []int
	for _, table := range []string{"tcp", "tcp6"} {
		data, err := os.ReadFile("/proc/net/" + table)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) > 9 && fields[3] == "0A" && sockets[fields[9]] {
				_, raw, _ := strings.Cut(fields[1], ":")
				port, err := strconv.ParseInt(raw, 16, 32)
				if err != nil {
					t.Fatal(err)
				}
				ports = append(ports, int(port))
			}
		}
	}
	sort.Ints(ports)
	return ports
}

func TestIndependentListeners(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("requires root and TUXEE_SYSTEM_TEST=1")
	}
	password := testPassword(t, "tuxee-poc-ports")
	for _, mode := range []string{"custom both", "https only", "http only", "defaults"} {
		t.Run(mode, func(t *testing.T) {
			httpPort, httpsPort := "0", "0"
			var reservations []net.Listener
			if mode == "defaults" {
				for _, port := range []string{"80", "443"} {
					l, err := net.Listen("tcp", ":"+port)
					if err != nil {
						for _, held := range reservations {
							held.Close()
						}
						t.Skipf("default port %s occupied; no running service changed", port)
					}
					reservations = append(reservations, l)
					t.Cleanup(func() { l.Close() })
				}
				httpPort, httpsPort = "80", "443"
			} else {
				if mode != "https only" {
					l := reservePort(t, "0")
					reservations = append(reservations, l)
					httpPort = strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
				}
				if mode != "http only" {
					l := reservePort(t, "0")
					reservations = append(reservations, l)
					httpsPort = strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
				}
				disabled := ""
				if mode == "https only" {
					disabled = "80"
				}
				if mode == "http only" {
					disabled = "443"
				}
				if disabled != "" {
					blocker, err := net.Listen("tcp", ":"+disabled)
					if err == nil {
						t.Cleanup(func() { blocker.Close() })
					} else if !strings.Contains(err.Error(), "address already in use") {
						t.Fatal(err)
					}
					t.Logf("disabled protocol's default port %s is occupied during startup", disabled)
				}
			}
			state := t.TempDir()
			args := []string{"serve", "--state", state, "--hosts", "127.0.0.1", "--acme", "off"}
			if mode != "defaults" {
				args = append(args, "--config", "../docker/tuxee.example.json")
			}
			cmd := exec.Command("../bin/tuxee", args...)
			cmd.Env = portEnvironment(httpPort, httpsPort)
			if mode == "defaults" {
				cmd.Env = portEnvironment("", "")
			}
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stderr = os.Stderr
			for _, held := range reservations {
				held.Close()
			}
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			t.Cleanup(func() {
				cmd.Process.Signal(syscall.SIGTERM)
				select {
				case err := <-done:
					if err != nil {
						t.Errorf("shutdown: %v", err)
					}
				case <-time.After(10 * time.Second):
					cmd.Process.Kill()
					<-done
					t.Error("shutdown timed out")
				}
			})
			lines := make(chan string, 16)
			go func() {
				defer close(lines)
				scanner := bufio.NewScanner(stdout)
				for scanner.Scan() {
					lines <- scanner.Text()
				}
			}()
			var want []int
			for _, port := range []string{httpPort, httpsPort} {
				if port != "0" {
					n, _ := strconv.Atoi(port)
					want = append(want, n)
				}
			}
			for started := 0; started < len(want); {
				select {
				case line, ok := <-lines:
					if !ok {
						t.Fatal("startup stopped")
					}
					if strings.Contains(line, "listening at ") {
						started++
					}
				case <-time.After(10 * time.Second):
					t.Fatal("startup timed out")
				}
			}
			sort.Ints(want)
			if got := processPorts(t, cmd.Process.Pid); !reflect.DeepEqual(got, want) {
				t.Fatalf("actual listener ports %v; want %v", got, want)
			}
			transport := &http.Transport{}
			defer transport.CloseIdleConnections()
			var bases []string
			if httpPort != "0" {
				bases = append(bases, "http://127.0.0.1:"+httpPort)
			}
			if httpsPort != "0" {
				pem, err := os.ReadFile(filepath.Join(state, "tls", "local-ca.pem"))
				if err != nil {
					t.Fatal(err)
				}
				roots := x509.NewCertPool()
				if !roots.AppendCertsFromPEM(pem) {
					t.Fatal("invalid CA")
				}
				transport.TLSClientConfig = &tls.Config{RootCAs: roots}
				bases = append(bases, "https://127.0.0.1:"+httpsPort)
			} else if _, err := os.Stat(filepath.Join(state, "tls")); !os.IsNotExist(err) {
				t.Fatal("HTTP-only initialized TLS state")
			}
			probe := exec.Command("../bin/tuxee", append([]string{"healthcheck"}, args[1:]...)...)
			probe.Env = cmd.Env
			if out, err := probe.CombinedOutput(); err != nil {
				t.Fatalf("image health probe: %v %s", err, out)
			}
			for _, base := range bases {
				t.Run(base, func(t *testing.T) {
					jar, _ := cookiejar.New(nil)
					client := &http.Client{Jar: jar, Transport: transport, Timeout: 10 * time.Second,
						CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
					var csrf string
					request := func(path, method string, body any, expected int, target any) *http.Response {
						t.Helper()
						data, _ := json.Marshal(body)
						req, _ := http.NewRequest(method, base+path, bytes.NewReader(data))
						req.Header.Set("Content-Type", "application/json")
						req.Header.Set("X-Tuxee-Client", "web")
						req.Header.Set("Origin", base)
						req.Header.Set("X-Tuxee-CSRF", csrf)
						response, err := client.Do(req)
						if err != nil {
							t.Fatal(err)
						}
						defer response.Body.Close()
						if response.StatusCode != expected {
							t.Fatalf("%s: got %d, want %d", path, response.StatusCode, expected)
						}
						if target != nil {
							if err := json.NewDecoder(response.Body).Decode(target); err != nil {
								t.Fatal(err)
							}
						} else {
							io.Copy(io.Discard, response.Body)
						}
						return response
					}
					page := request("/", "GET", nil, 200, nil)
					if page.Header.Get("Content-Type") != "text/html; charset=utf-8" || (page.TLS != nil) != strings.HasPrefix(base, "https://") {
						t.Fatal("listener did not serve the application directly")
					}
					var ready struct{ Authenticated bool }
					request("/api/connection", "GET", nil, 200, &ready)
					if ready.Authenticated {
						t.Fatal("anonymous client authenticated")
					}
					var login struct{ CSRF string }
					response := request("/api/login", "POST", map[string]string{"username": "tuxee-poc-ports", "password": password}, 200, &login)
					if len(response.Cookies()) != 1 {
						t.Fatal("missing session cookie")
					}
					cookie := response.Cookies()[0]
					if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Secure != strings.HasPrefix(base, "https://") {
						t.Fatal("incorrect session cookie security")
					}
					csrf = login.CSRF
					request("/api/connection", "GET", nil, 200, &ready)
					if !ready.Authenticated {
						t.Fatal("cookie not admitted")
					}
					var term struct{ ID string }
					request("/api/terminals", "POST", map[string]any{"directory": "/tmp", "columns": 80, "rows": 24}, 201, &term)
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					ws, _, err := websocket.Dial(ctx, strings.Replace(base, "http", "ws", 1)+"/api/terminals/"+term.ID+"/ws", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": {base}}})
					if err != nil {
						t.Fatal(err)
					}
					defer ws.CloseNow()
					if _, _, err = ws.Read(ctx); err != nil {
						t.Fatal("terminal WebSocket did not deliver initial event", err)
					}
					ws.CloseNow()
					request("/api/terminals/"+term.ID, "DELETE", nil, 200, nil)
					request("/api/logout", "POST", nil, 200, nil)
					request("/api/connection", "GET", nil, 200, &ready)
					if ready.Authenticated {
						t.Fatal("logout did not revoke cookie")
					}
				})
			}
		})
	}
}

func TestPortStartupFailures(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("requires root and TUXEE_SYSTEM_TEST=1")
	}
	for _, tc := range []struct{ http, https, diagnostic string }{{"0", "0", "no listeners configured"}, {"", "invalid", "TUXEE_HTTPS_PORT"}, {"65536", "0", "TUXEE_HTTP_PORT"}} {
		state := filepath.Join(t.TempDir(), "not-created")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		cmd := exec.CommandContext(ctx, "../bin/tuxee", "serve", "--state", state)
		cmd.Env = portEnvironment(tc.http, tc.https)
		out, err := cmd.CombinedOutput()
		cancel()
		if err == nil || !strings.Contains(string(out), tc.diagnostic) {
			t.Fatalf("expected startup refusal %q: %v %s", tc.diagnostic, err, out)
		}
		if _, err := os.Stat(state); !os.IsNotExist(err) {
			t.Fatal("invalid/no-listener startup created state")
		}
	}
	// If the second bind fails, the first is closed; never leave a partially running service.
	occupied := reservePort(t, "0")
	available := reservePort(t, "0")
	httpPort := strconv.Itoa(occupied.Addr().(*net.TCPAddr).Port)
	httpsPort := strconv.Itoa(available.Addr().(*net.TCPAddr).Port)
	available.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "../bin/tuxee", "serve", "--state", t.TempDir(), "--acme", "off")
	cmd.Env = portEnvironment(httpPort, httpsPort)
	if out, err := cmd.CombinedOutput(); err == nil || !strings.Contains(string(out), "address already in use") {
		t.Fatalf("bind failure: %v %s", err, out)
	}
	probe, err := net.Listen("tcp", ":"+httpsPort)
	if err != nil {
		t.Fatal("first listener leaked after second bind failed", err)
	}
	probe.Close()
}
