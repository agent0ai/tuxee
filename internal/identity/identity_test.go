package identity

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "__auth" {
		if RunAuthHelper() != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestPAMAndCredentials(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("TUXEE_SYSTEM_TEST") != "1" {
		t.Skip("set TUXEE_SYSTEM_TEST=1 as root to exercise dedicated Linux accounts")
	}
	for _, name := range []string{"tuxee-poc-a", "tuxee-poc-b"} {
		account, err := user.Lookup(name)
		if err != nil {
			if err = exec.Command("useradd", "--create-home", "--shell", "/bin/bash", "--comment", "Tuxee prototype test", name).Run(); err != nil {
				t.Fatal(err)
			}
		} else if account.Name != "Tuxee prototype test" {
			t.Fatalf("refusing to modify unrelated account %s", name)
		}
	}
	if err := exec.Command("usermod", "--append", "--groups", "tuxee-poc-b", "tuxee-poc-a").Run(); err != nil {
		t.Fatal(err)
	}
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	password := []byte(hex.EncodeToString(random[:]))
	defer clear(password)
	cmd := exec.Command("chpasswd")
	payload := append(append([]byte("tuxee-poc-a:"), password...), '\n')
	cmd.Stdin = bytes.NewReader(payload)
	err := cmd.Run()
	clear(payload)
	if err != nil {
		t.Fatal(err)
	}
	u, err := Authenticate(context.Background(), "login", "tuxee-poc-a", bytes.Clone(password))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Authenticate(context.Background(), "login", "tuxee-poc-a", []byte("incorrect-test-password")); err == nil {
		t.Fatal("incorrect password accepted")
	}
	if u.UID == 0 || u.Name != "tuxee-poc-a" {
		t.Fatal("wrong Linux identity")
	}
	dir, err := os.MkdirTemp("/tmp", "tuxee-identity-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	if err = os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "private")
	if err = os.WriteFile(path, []byte("allowed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chown(path, int(u.UID), int(u.GID)); err != nil {
		t.Fatal(err)
	}
	output, err := u.Command(context.Background(), "/bin/cat", path).Output()
	if err != nil || string(output) != "allowed" {
		t.Fatalf("owner read failed: %v", err)
	}
	other, err := Lookup("tuxee-poc-b")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = other.Command(context.Background(), "/bin/cat", path).Output(); err == nil {
		t.Fatal("another user read private file")
	}
	if err = os.Chown(path, 0, int(other.GID)); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0640); err != nil {
		t.Fatal(err)
	}
	if _, err = u.Command(context.Background(), "/bin/cat", path).Output(); err != nil {
		t.Fatalf("supplementary group permission was lost: %v", err)
	}
	for _, entry := range u.Command(context.Background(), "/usr/bin/env").Env {
		if strings.HasPrefix(entry, "GITHUB_TOKEN=") {
			t.Fatal("server credential leaked into child")
		}
	}
}
