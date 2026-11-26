package files

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tuxee/internal/security"
)

func TestFactorEnrollmentRecoveryAndReset(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	ctx := context.Background()
	secret := security.NewSecret()
	code := security.Code(secret, time.Now().Unix()/30)
	result, err := securityOperation(ctx, Request{Operation: "security-enable", Content: secret, Version: code})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Security.Enabled || len(result.Security.RecoveryCodes) != 8 {
		t.Fatal("incomplete enrollment")
	}
	codes := result.Security.RecoveryCodes
	if _, err = securityOperation(ctx, Request{Operation: "security-verify", Content: code}); err == nil {
		t.Fatal("enrollment code replayed")
	}
	var successes atomic.Int32
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			if _, err := securityOperation(ctx, Request{Operation: "security-verify", Content: codes[0]}); err == nil {
				successes.Add(1)
			}
		})
	}
	workers.Wait()
	if successes.Load() != 1 {
		t.Fatal("recovery code was not single-use")
	}
	// Recover from the intentionally triggered guess limit using the administrator path.
	path := filepath.Join(home, ".config/tuxee/security/two-factor.json")
	if err = os.WriteFile(filepath.Join(home, ".config/tuxee/settings.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(filepath.Join(home, ".config/tuxee"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err = resetConfiguration(ctx); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(home, ".config/tuxee")); err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("reset left a public configuration directory", err)
	}
	if _, err = os.Stat(path); err != nil {
		t.Fatal("settings reset removed 2FA", err)
	}
	if err = os.WriteFile(path, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = securityOperation(ctx, Request{Operation: "security-status"}); err == nil {
		t.Fatal("corrupt factor bypassed")
	}
	if _, err = securityOperation(ctx, Request{Operation: "security-clear"}); err != nil {
		t.Fatal(err)
	}
	result, err = securityOperation(ctx, Request{Operation: "security-status"})
	if err != nil || result.Security.Enabled {
		t.Fatal("CLI recovery failed", err)
	}
}

func TestFactorThrottlingAndDisable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	ctx := context.Background()
	secret := security.NewSecret()
	result, err := securityOperation(ctx, Request{Operation: "security-enable", Content: secret, Version: security.Code(secret, time.Now().Unix()/30)})
	if err != nil {
		t.Fatal(err)
	}
	for range 5 {
		if _, err = securityOperation(ctx, Request{Operation: "security-verify", Content: "bad"}); err == nil {
			t.Fatal("bad code accepted")
		}
	}
	if _, err = securityOperation(ctx, Request{Operation: "security-verify", Content: result.Security.RecoveryCodes[0]}); err == nil {
		t.Fatal("guess limit bypassed")
	}
	if _, err = securityOperation(ctx, Request{Operation: "security-clear"}); err != nil {
		t.Fatal(err)
	}
	result, err = securityOperation(ctx, Request{Operation: "security-enable", Content: secret, Version: security.Code(secret, time.Now().Unix()/30)})
	if err != nil {
		t.Fatal(err)
	}
	result, err = securityOperation(ctx, Request{Operation: "security-disable", Content: result.Security.RecoveryCodes[0]})
	if err != nil || result.Security.Enabled {
		t.Fatal("disable failed", err)
	}
}
