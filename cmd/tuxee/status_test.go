package main

import (
	"bytes"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"tuxee/internal/server"
	"tuxee/internal/terminal"
)

func TestListenerHealth(t *testing.T) {
	var calls atomic.Int32
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" || r.Method != "GET" {
			t.Errorf("unexpected probe: %s %s", r.Method, r.URL)
		}
		calls.Add(1)
		w.Write([]byte("ok"))
	})
	httpServer := httptest.NewServer(ok)
	defer httpServer.Close()
	tlsServer := httptest.NewTLSServer(ok)
	defer tlsServer.Close()
	listeners := []runtimeListener{{httpServer.Listener.Addr().String(), false}, {tlsServer.Listener.Addr().String(), true}}
	if got := checkListeners(listeners, time.Second); !reflect.DeepEqual(got, []string{"OK", "OK"}) || calls.Load() != 2 {
		t.Fatalf("probes = %v, calls = %d", got, calls.Load())
	}
	for _, code := range []int{503, 302} {
		failed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", httpServer.URL+"/health")
			w.WriteHeader(code)
		}))
		got := checkListeners([]runtimeListener{{failed.Listener.Addr().String(), false}}, time.Second)
		failed.Close()
		if got[0] == "OK" || calls.Load() != 2 {
			t.Fatalf("accepted or followed HTTP %d: %v", code, got)
		}
	}
	httpServer.Close()
	if got := checkListeners(listeners[:1], time.Second); got[0] != "Connection refused" {
		t.Fatalf("closed listener: %v", got)
	}
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer slow.Close()
	if got := checkListeners([]runtimeListener{{slow.Listener.Addr().String(), false}}, 20*time.Millisecond); got[0] != "Timeout" {
		t.Fatalf("stalled listener: %v", got)
	}
	for _, network := range []string{"tcp4", "tcp6"} {
		t.Run(network, func(t *testing.T) {
			listener, err := net.Listen(network, ":0")
			if err != nil {
				t.Skipf("%s unavailable: %v", network, err)
			}
			s := &http.Server{Handler: ok}
			defer s.Close()
			go s.Serve(listener)
			if got := checkListeners([]runtimeListener{{listener.Addr().String(), false}}, time.Second); got[0] != "OK" {
				t.Fatalf("wildcard listener %s: %v", listener.Addr(), got)
			}
		})
	}
}

func TestStatusOutput(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("runtime records are owned by root")
	}
	directory, state := t.TempDir(), t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	app := &server.Server{Terminals: terminal.NewManager()}
	closeStatus, err := serveStatus(directory, app)
	if err != nil {
		t.Fatal(err)
	}
	defer closeStatus()
	info, err := os.Stat(statusSocket(directory, os.Getpid()))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("status socket permissions: %v, %v", info, err)
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }))
	defer s.Close()
	failed := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer failed.Close()
	good, bad := runtimeListener{s.Listener.Addr().String(), false}, runtimeListener{failed.Listener.Addr().String(), true}
	for _, tc := range []struct {
		name      string
		listeners []runtimeListener
		want      []string
		fail      bool
	}{
		{"healthy", []runtimeListener{good}, []string{"Healthy", good.Address + "  OK", "HTTPS", "Disabled", "0 signed-in users", "0 running"}, false},
		{"degraded", []runtimeListener{good, bad}, []string{"Degraded", bad.Address + "  HTTP 503"}, true},
		{"unresponsive", []runtimeListener{bad}, []string{"Unresponsive", "HTTP 503"}, true},
		{"older runtime", nil, []string{"Unknown", "Restart Tuxee to enable runtime details"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status := &runtimeStatus{Version: "running-version", StartedAt: time.Now().Add(-49 * time.Hour), Listeners: tc.listeners}
			if tc.listeners == nil {
				status = nil
			}
			unregister, err := registerRuntime(directory, state, status)
			if err != nil {
				t.Fatal(err)
			}
			defer unregister()
			var output bytes.Buffer
			err = showStatus(&output, directory, executable, state)
			if (err != nil) != tc.fail {
				t.Fatalf("error = %v; output:\n%s", err, output.String())
			}
			want := append([]string{"Tuxee status", "Running", "PID"}, tc.want...)
			if status != nil {
				want = append(want, "running-version", "2d 1h")
			}
			for _, value := range want {
				if !strings.Contains(output.String(), value) {
					t.Errorf("missing %q in:\n%s", value, output.String())
				}
			}
		})
	}
	closeStatus()
	if _, err := os.Lstat(statusSocket(directory, os.Getpid())); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket left after shutdown: %v", err)
	}
	unregister, err := registerRuntime(directory, state, &runtimeStatus{Version: "1.2.3", StartedAt: time.Now(), Listeners: []runtimeListener{good}})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := showStatus(&output, directory, executable, state); err != nil || !strings.Contains(output.String(), "Unavailable") || strings.Contains(output.String(), "0 running") {
		t.Fatalf("unavailable counts: %v\n%s", err, output.String())
	}
	unregister()
	output.Reset()
	if err := showStatus(&output, directory, executable, state); !errors.Is(err, errRuntimeNotFound) || !strings.Contains(output.String(), "Not running") {
		t.Fatalf("stopped output: %v\n%s", err, output.String())
	}
	path := statusSocket(directory, os.Getpid())
	if err := os.Symlink(filepath.Join(directory, "unrelated"), path); err != nil {
		t.Fatal(err)
	}
	if stop, err := serveStatus(directory, app); err == nil {
		stop()
		t.Fatal("replaced unrelated status socket symlink")
	}
}

func TestStatusUptimeAndArguments(t *testing.T) {
	for _, tc := range []struct {
		duration time.Duration
		want     string
	}{{-time.Second, "0s"}, {time.Second, "1s"}, {61 * time.Second, "1m 1s"}, {61 * time.Minute, "1h 1m"}, {25 * time.Hour, "1d 1h"}} {
		if got := statusUptime(tc.duration); got != tc.want {
			t.Errorf("uptime %s = %s; want %s", tc.duration, got, tc.want)
		}
	}
	for _, args := range [][]string{{"unexpected"}, {"--http-port", "80"}, {"--name", "../bad"}} {
		if err := runStatus(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestStatusSocketLifecycle(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("runtime directory is owned by root")
	}
	dir := t.TempDir()
	path := statusSocket(dir, os.Getpid())
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	stale.Close()
	for range 10 {
		stop, err := serveStatus(dir, &server.Server{Terminals: terminal.NewManager()})
		if err != nil {
			t.Fatal(err)
		}
		stop()
		stop()
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("immediate shutdown left a status socket: %v", err)
		}
	}
}
