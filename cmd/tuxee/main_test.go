package main

import (
	"os"
	"path/filepath"
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
