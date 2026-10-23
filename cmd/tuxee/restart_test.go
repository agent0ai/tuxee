package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestRuntimeSelection(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("runtime records are owned by root")
	}
	dir, state := t.TempDir(), t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	unregister, err := registerRuntime(dir, state)
	if err != nil {
		t.Fatal(err)
	}
	defer unregister()
	path := filepath.Join(dir, strconv.Itoa(os.Getpid())+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record runtimeRecord
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	write := func(path string, r runtimeRecord) {
		t.Helper()
		data, _ := json.Marshal(r)
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	check := func(state string, wantError string) {
		t.Helper()
		proc, err := findRuntime(dir, executable, state)
		if wantError != "" {
			if proc != nil {
				proc.Close()
			}
			if err == nil || !strings.Contains(err.Error(), wantError) {
				t.Fatalf("want %s, got %v", wantError, err)
			}
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		defer proc.Close()
		if err := unix.PidfdSendSignal(int(proc.Fd()), 0, nil, 0); err != nil {
			t.Fatal(err)
		}
	}
	check("", "")
	check(state, "")
	check(t.TempDir(), "no running")
	for _, field := range []string{"start", "boot", "executable", "protocol"} {
		bad := record
		switch field {
		case "start":
			bad.Start = "0"
		case "boot":
			bad.Boot = "earlier boot"
		case "executable":
			bad.Executable = "/unrelated/tuxee"
		case "protocol":
			bad.Protocol = 0
		}
		write(path, bad)
		check("", "no running")
	}
	write(path, record)
	other := record
	other.State = t.TempDir()
	write(filepath.Join(dir, "other.json"), other)
	check("", "multiple")
	check(state, "")
	if err := os.Remove(filepath.Join(dir, "other.json")); err != nil {
		t.Fatal(err)
	}
	unregister()
	check("", "no running")
	if err := os.Chmod(dir, 0777); err != nil {
		t.Fatal(err)
	}
	check("", "unsafe runtime directory")
}
