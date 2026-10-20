package service

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallRepeatPreservesConfigAndRefusesUnrelated(t *testing.T) {
	dir := t.TempDir()
	p := paths{filepath.Join(dir, "units/tuxee-poc.service"), filepath.Join(dir, "lib/tuxee"), filepath.Join(dir, "etc/config.json")}
	source := filepath.Join(dir, "source")
	if err := os.WriteFile(source, []byte("binary one"), 0755); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(dir, "state")
	if err := installFiles(p, source, state, []byte(`{"bind":":443"}`)); err != nil {
		t.Fatal(err)
	}
	if err := installFiles(p, source, state, []byte(`{"bind":":99"}`)); err != nil {
		t.Fatal(err)
	}
	config, _ := os.ReadFile(p.config)
	if !bytes.Equal(config, []byte(`{"bind":":443"}`)) {
		t.Fatal("reinstall overwrote configuration")
	}
	if err := os.Remove(p.unit); err != nil {
		t.Fatal(err)
	}
	if err := installFiles(p, source, state, []byte(`{"bind":":99"}`)); err != nil {
		t.Fatalf("cannot reinstall after unregistering the service: %v", err)
	}
	if err := os.WriteFile(p.unit, []byte("unrelated"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := installFiles(p, source, state, nil); err == nil {
		t.Fatal("overwrote unrelated unit")
	}
	data, _ := os.ReadFile(p.unit)
	if string(data) != "unrelated" {
		t.Fatal("modified unrelated unit")
	}
}

func TestUnitAcceptedBySystemd(t *testing.T) {
	tool, err := exec.LookPath("systemd-analyze")
	if err != nil {
		t.Skip("systemd-analyze unavailable")
	}
	dir := t.TempDir()
	p := paths{unit: filepath.Join(dir, "tuxee-poc.service"), binary: "/bin/true", config: filepath.Join(dir, "config.json")}
	if err := os.WriteFile(p.unit, []byte(unit(p)), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(tool, "verify", p.unit).CombinedOutput(); err != nil {
		t.Fatalf("systemd rejected generated unit: %v\n%s", err, output)
	}
}
func TestUnitQuotesAndNameValidation(t *testing.T) {
	if ValidateName("../sshd") == nil || ValidateName("tuxee-poc") != nil {
		t.Fatal("invalid name validation")
	}
	value := unit(paths{binary: "/path with spaces/100%$bin", config: "/etc/tuxee/config.json"})
	if !strings.Contains(value, `ExecStart="/path with spaces/100%%$$bin" serve`) || !strings.Contains(value, "KillMode=control-group") {
		t.Fatal(value)
	}
}
