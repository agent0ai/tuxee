package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestPortsSaveAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	original := `{"httpPort":8080,"httpsPort":8443,"state":"/var/lib/custom","hosts":"localhost","acme":"off","acmeDirectory":"https://ca.test/directory","email":"admin@example.test","pam":"custom","origin":"https://example.test"}`
	if err := os.WriteFile(path, []byte(original), 0640); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(path, 12345, 12346); err != nil {
			t.Fatal(err)
		}
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	want, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		args        []string
		http, https int
	}{
		{[]string{"--http-port", "0"}, 0, 8443},
		{[]string{"--http-port=9090", "--https-port=0"}, 9090, 0},
		{[]string{"--https-port", "9443"}, 9090, 9443},
	} {
		// A shell override must never leak into the saved service configuration.
		t.Setenv("TUXEE_HTTP_PORT", "1234")
		t.Setenv("TUXEE_HTTPS_PORT", "invalid")
		var output bytes.Buffer
		if err := runPorts(append([]string{"--config", path}, tc.args...), &output); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(output.String(), "Restart Tuxee to apply") || !strings.Contains(output.String(), "override these saved settings") {
			t.Fatalf("missing apply/override guidance: %s", &output)
		}
		os.Unsetenv("TUXEE_HTTP_PORT")
		os.Unsetenv("TUXEE_HTTPS_PORT")
		got, _, err := parseConfig([]string{"--config", path}, false)
		if err != nil {
			t.Fatal(err)
		}
		want.HTTPPort, want.HTTPSPort = &tc.http, &tc.https
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("saved config = %+v, want %+v", got, want)
		}
		after, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		oldOwner, newOwner := before.Sys().(*syscall.Stat_t), after.Sys().(*syscall.Stat_t)
		if before.Mode() != after.Mode() || oldOwner.Uid != newOwner.Uid || oldOwner.Gid != newOwner.Gid {
			t.Fatal("configuration permissions or owner changed")
		}
	}
}

func TestPortsShowDoesNotWrite(t *testing.T) {
	for _, tc := range []struct {
		json, http, https string
	}{
		{`{}`, ":80", ":443"},
		{`{"httpPort":0,"httpsPort":8443}`, "disabled", ":8443"},
		{`{"http":true,"bind":"127.0.0.1:8080"}`, "127.0.0.1:8080", "disabled"},
	} {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(tc.json), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("TUXEE_HTTP_PORT", "8888")
		var output bytes.Buffer
		if err := runPorts([]string{"--config", path}, &output); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(output.String(), "HTTP: "+tc.http+"\n") || !strings.Contains(output.String(), "HTTPS: "+tc.https+"\n") || strings.Contains(output.String(), "Saved.") {
			t.Fatalf("wrong displayed ports: %s", &output)
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != tc.json {
			t.Fatalf("show changed configuration: %s, %v", data, err)
		}
	}
}

func TestPortsRejectWithoutWriting(t *testing.T) {
	for _, tc := range []struct {
		name, json string
		args       []string
	}{
		{"negative", `{}`, []string{"--http-port=-1"}},
		{"out of range", `{}`, []string{"--https-port=65536"}},
		{"malformed", `{}`, []string{"--http-port=+80"}},
		{"same ports", `{}`, []string{"--http-port=443"}},
		{"both disabled", `{}`, []string{"--http-port=0", "--https-port=0"}},
		{"remaining disabled", `{"httpsPort":0}`, []string{"--http-port=0"}},
		{"legacy", `{"bind":"127.0.0.1:8080","http":true}`, []string{"--http-port=9090"}},
		{"unknown field", `{"unknown":true}`, []string{"--http-port=9090"}},
		{"invalid JSON", `{`, []string{"--http-port=9090"}},
		{"null JSON", `null`, []string{"--http-port=9090"}},
		{"multiple objects", `{} {}`, []string{"--http-port=9090"}},
		{"invalid state", `{"state":"/"}`, []string{"--http-port=9090"}},
		{"extra arguments", `{}`, []string{"--http-port=9090", "extra"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(tc.json), 0600); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			if err := runPorts(append([]string{"--config", path}, tc.args...), &output); err == nil {
				t.Fatal("accepted invalid update")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != tc.json {
				t.Fatalf("invalid update changed configuration: %s, %v", data, err)
			}
			entries, err := os.ReadDir(filepath.Dir(path))
			if err != nil || len(entries) != 1 {
				t.Fatalf("temporary files left behind: %v, %v", entries, err)
			}
		})
	}
	path := filepath.Join(t.TempDir(), "config.json")
	var output bytes.Buffer
	if err := runPorts([]string{"--config", path, "--http-port=9090"}, &output); err == nil {
		t.Fatal("created a missing configuration")
	}
	if err := os.WriteFile(path, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	link := path + ".link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if err := runPorts([]string{"--config", link, "--http-port=9090"}, &output); err == nil {
		t.Fatal("replaced a symlink")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != `{}` {
		t.Fatalf("symlink target changed: %s, %v", data, err)
	}
}
