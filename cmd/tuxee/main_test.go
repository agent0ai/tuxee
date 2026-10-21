package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestConfigOverridesAndLock(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "config.json")
	if err := os.WriteFile(file, []byte(`{"bind":"127.0.0.1:8443","http":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	value, _, err := parseConfig([]string{"--config", file, "--bind", "127.0.0.1:9443"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if value.Bind != "127.0.0.1:9443" || !value.HTTP {
		t.Fatalf("wrong configuration: %+v", value)
	}
	first, err := lockState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := lockState(filepath.Join(dir, "state")); err == nil {
		second.Close()
		t.Fatal("allowed concurrent state owner")
	}
}

func TestIndependentPortConfig(t *testing.T) {
	for _, key := range []string{"TUXEE_HTTP_PORT", "TUXEE_HTTPS_PORT"} {
		t.Setenv(key, "")
		os.Unsetenv(key)
	}
	for _, tc := range []struct {
		name, json string
		env        map[string]string
		args       []string
		want       []listenerConfig
		invalid    bool
	}{
		{name: "defaults", want: []listenerConfig{{":443", true}, {":80", false}}},
		{name: "https only", env: map[string]string{"TUXEE_HTTP_PORT": "0"}, want: []listenerConfig{{":443", true}}},
		{name: "http only", env: map[string]string{"TUXEE_HTTPS_PORT": "0"}, want: []listenerConfig{{":80", false}}},
		{name: "both disabled", env: map[string]string{"TUXEE_HTTP_PORT": "0", "TUXEE_HTTPS_PORT": "0"}},
		{name: "custom", env: map[string]string{"TUXEE_HTTP_PORT": "8080", "TUXEE_HTTPS_PORT": "8443"}, want: []listenerConfig{{":8443", true}, {":8080", false}}},
		{name: "flags over env over JSON", json: `{"httpPort":81,"httpsPort":444}`, env: map[string]string{"TUXEE_HTTP_PORT": "8080", "TUXEE_HTTPS_PORT": "8443"}, args: []string{"--https-port", "0"}, want: []listenerConfig{{":8080", false}}},
		{name: "JSON zero", json: `{"httpPort":0,"httpsPort":8443}`, want: []listenerConfig{{":8443", true}}},
		{name: "bounds", args: []string{"--http-port=1", "--https-port=65535"}, want: []listenerConfig{{":65535", true}, {":1", false}}},
		{name: "legacy TLS", args: []string{"--bind", "127.0.0.1:0"}, want: []listenerConfig{{"127.0.0.1:0", true}}},
		{name: "legacy HTTP", json: `{"http":true,"bind":"127.0.0.1:8080"}`, want: []listenerConfig{{"127.0.0.1:8080", false}}},
		{name: "legacy default", args: []string{"--http"}, want: []listenerConfig{{":443", false}}},
		{name: "mixed bind", args: []string{"--bind", ":443", "--http-port", "0"}, invalid: true},
		{name: "mixed env", json: `{"http":true}`, env: map[string]string{"TUXEE_HTTPS_PORT": "0"}, invalid: true},
		{name: "same port", args: []string{"--http-port", "443"}, invalid: true},
		{name: "HTTP redirect origin", args: []string{"--origin", "http://example.test"}, invalid: true},
		{name: "negative JSON", json: `{"httpPort":-1}`, invalid: true},
		{name: "high JSON", json: `{"httpsPort":65536}`, invalid: true},
		{name: "fraction JSON", json: `{"httpsPort":1.5}`, invalid: true},
		{name: "string JSON", json: `{"httpsPort":"443"}`, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for key, value := range tc.env {
				t.Setenv(key, value)
			}
			args := tc.args
			if tc.json != "" {
				path := filepath.Join(t.TempDir(), "config.json")
				if err := os.WriteFile(path, []byte(tc.json), 0600); err != nil {
					t.Fatal(err)
				}
				args = append([]string{"--config", path}, args...)
			}
			value, _, err := parseConfig(args, false)
			if tc.invalid {
				if err == nil {
					t.Fatal("accepted invalid config")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := value.listeners()
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("listeners = %v, %v; want %v", got, err, tc.want)
			}
			// The installed service reloads the same effective ports, including explicit zero.
			data, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			var reloaded config
			if err := json.Unmarshal(data, &reloaded); err != nil {
				t.Fatal(err)
			}
			again, err := reloaded.listeners()
			if err != nil || !reflect.DeepEqual(got, again) {
				t.Fatalf("port settings lost during service serialization: %v %v", again, err)
			}
		})
	}
	for _, raw := range []string{"", " ", " 80", "80 ", "-1", "+80", "65536", "1.5", "0x50", "http", "9999999999999999999999999"} {
		for _, key := range []string{"TUXEE_HTTP_PORT", "TUXEE_HTTPS_PORT"} {
			t.Run(key+"="+raw, func(t *testing.T) {
				t.Setenv(key, raw)
				if _, _, err := parseConfig(nil, false); err == nil || !strings.Contains(err.Error(), key) {
					t.Fatalf("missing diagnostic: %v", err)
				}
			})
		}
		if _, _, err := parseConfig([]string{"--http-port=" + raw}, false); err == nil {
			t.Fatalf("accepted flag %q", raw)
		}
	}
}
