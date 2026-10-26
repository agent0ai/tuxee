package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestInstanceIDPersistsAndIsUnique(t *testing.T) {
	state := t.TempDir()
	id, err := loadInstanceID(state)
	if err != nil || !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(id) {
		t.Fatalf("create instance ID: %q, %v", id, err)
	}
	again, err := loadInstanceID(state)
	if err != nil || again != id {
		t.Fatalf("instance ID changed: %q, %v", again, err)
	}
	other, err := loadInstanceID(t.TempDir())
	if err != nil || other == id {
		t.Fatalf("independent state reused instance ID: %q, %v", other, err)
	}
	info, err := os.Stat(filepath.Join(state, "instance-id"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("instance ID permissions: %v, %v", info, err)
	}
	entries, err := os.ReadDir(state)
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary instance files remain: %v, %v", entries, err)
	}
}

func TestInstanceIDRejectsInvalidState(t *testing.T) {
	for _, value := range []string{"", "short", strings.Repeat("g", 32), strings.Repeat("a", 30), strings.Repeat("a", 34), "id; Path=/"} {
		t.Run(value, func(t *testing.T) {
			state := t.TempDir()
			path := filepath.Join(state, "instance-id")
			if err := os.WriteFile(path, []byte(value), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadInstanceID(state); err == nil {
				t.Fatal("accepted invalid instance ID")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != value {
				t.Fatal("replaced invalid instance ID instead of reporting it")
			}
		})
	}
	state := t.TempDir()
	if err := os.Mkdir(filepath.Join(state, "instance-id"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := loadInstanceID(state); err == nil {
		t.Fatal("ignored instance ID read error")
	}
}
