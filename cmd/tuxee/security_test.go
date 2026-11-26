package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"tuxee/internal/security"
)

func TestSecurityNetworkCLI(t *testing.T) {
	directory := t.TempDir()
	var output bytes.Buffer
	if err := runSecurity([]string{"network", "--state", directory, "--allow", "10.8.0.0/24,2001:db8::/64", "--trusted-proxies", "127.0.0.1"}, &output); err != nil {
		t.Fatal(err)
	}
	store := &security.NetworkStore{Directory: directory}
	value, err := store.Load()
	if err != nil || len(value.AllowedNetworks) != 2 || len(value.TrustedProxies) != 1 {
		t.Fatal("CLI did not save policy", err)
	}
	if err = runSecurity([]string{"network", "--state", directory, "--allow", "10.*"}, &output); err == nil {
		t.Fatal("invalid network accepted")
	}
	if err = os.WriteFile(filepath.Join(directory, "security.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = runSecurity([]string{"network", "--state", directory, "--clear"}, &output); err != nil {
		t.Fatal(err)
	}
	value, err = store.Load()
	if err != nil || len(value.AllowedNetworks) != 0 || len(value.TrustedProxies) != 0 {
		t.Fatal("recovery did not clear corrupt policy", err)
	}
}
