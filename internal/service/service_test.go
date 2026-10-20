package service

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"tuxee/internal/update"
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

func TestRegisterBootstrappedBinary(t *testing.T) {
	dir := t.TempDir()
	p := paths{filepath.Join(dir, "units/tuxee.service"), filepath.Join(dir, "lib/tuxee"), filepath.Join(dir, "etc/config.json")}
	if err := os.MkdirAll(filepath.Dir(p.binary), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.binary, []byte("bootstrapped executable"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := installFiles(p, p.binary, filepath.Join(dir, "state"), []byte("{}")); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p.binary)
	if string(data) != "bootstrapped executable" {
		t.Fatal("registration changed executable")
	}
	if owned, err := managedUnit(p.unit); !owned || err != nil {
		t.Fatal(owned, err)
	}
	lock, err := update.LockDirectory(filepath.Dir(p.binary))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := installFiles(p, p.binary, filepath.Join(dir, "state"), []byte("{}")); err == nil {
		t.Fatal("service registration ignored the updater's installation lock")
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
