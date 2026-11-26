package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"tuxee/internal/identity"
	"tuxee/internal/security"
	"tuxee/web"
)

func TestNetworkAdmissionAndRevocation(t *testing.T) {
	s := New("network-test", nil, nil, nil, "", web.Assets())
	s.Network = &security.NetworkStore{Directory: t.TempDir()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	key := sha256.Sum256([]byte("session"))
	s.logins[key] = &login{ctx: ctx, cancel: cancel, clientIP: "192.0.2.1", expires: time.Now().Add(time.Hour)}
	if err := s.Network.Save(security.Network{AllowedNetworks: []string{"10.8.0.0/24"}}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/api/login", "/api/connection", "/api/terminals/a/ws"} {
		r := httptest.NewRequest("GET", "http://tuxee.test"+path, nil)
		r.RemoteAddr = "192.0.2.1:1000"
		r.Header.Set("X-Forwarded-For", "10.8.0.1")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("filter bypassed at %s: %d", path, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://tuxee.test/health", nil)
	r.RemoteAddr = "192.0.2.1:1000"
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "ok" {
		t.Fatal("health contract changed")
	}
	s.pruneSecurity()
	select {
	case <-ctx.Done():
	default:
		t.Fatal("existing transports not revoked")
	}
	if len(s.logins) != 0 {
		t.Fatal("disallowed session retained")
	}
	if err := os.WriteFile(filepath.Join(s.Network.Directory, "security.json"), []byte("null"), 0600); err != nil {
		t.Fatal(err)
	}
	r = httptest.NewRequest("GET", "http://tuxee.test/", nil)
	r.RemoteAddr = "10.8.0.1:1000"
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("corrupt policy failed open")
	}
}

func TestSecondFactorChallengeHasNoSession(t *testing.T) {
	s := New("mfa-test", nil, nil, nil, "", web.Assets())
	r := httptest.NewRequest("POST", "http://tuxee.test/api/login", nil)
	r.RemoteAddr = "192.0.2.1:1000"
	w := httptest.NewRecorder()
	s.beginSecondFactor(w, r, identity.User{Name: "alice"}, "cs")
	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || len(result["challenge"]) != 64 || len(s.logins) != 0 || w.Header().Get("Set-Cookie") != "" {
		t.Fatal("first factor granted access")
	}
	pending := s.pendingLogins[sha256.Sum256([]byte(result["challenge"]))]
	if pending.language != "cs" {
		t.Fatal("lost login language")
	}
	other := httptest.NewRequest("POST", "http://tuxee.test/api/login", nil)
	other.RemoteAddr = "192.0.2.2:1000"
	w = httptest.NewRecorder()
	s.completeSecondFactor(w, other, result["challenge"], "123456")
	if w.Code != 401 || len(s.logins) != 0 {
		t.Fatal("challenge moved to another client")
	}
}

func TestFactorLocksKeepAccountsIndependent(t *testing.T) {
	s := New("factor-lock-test", nil, nil, nil, "", web.Assets())
	unlock := s.lockFactor(1)
	defer unlock()
	done := make(chan struct{})
	go func() { release := s.lockFactor(2); release(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("one account blocked another account's authentication")
	}
}

func TestSecondFactorChallengesBoundedPerAccount(t *testing.T) {
	s := New("mfa-limit-test", nil, nil, nil, "", web.Assets())
	r := httptest.NewRequest("POST", "http://tuxee.test/api/login", nil)
	var first map[string]string
	for i := range 130 {
		w := httptest.NewRecorder()
		s.beginSecondFactor(w, r, identity.User{UID: 1000}, "en")
		if w.Code != 200 {
			t.Fatalf("login %d could not start: %d", i, w.Code)
		}
		if i == 0 {
			if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
				t.Fatal(err)
			}
		}
	}
	if len(s.pendingLogins) != 4 || s.pendingLogins[sha256.Sum256([]byte(first["challenge"]))] != nil {
		t.Fatal("abandoned challenges were not replaced")
	}
	w := httptest.NewRecorder()
	s.beginSecondFactor(w, r, identity.User{UID: 1001}, "en")
	if w.Code != 200 {
		t.Fatal("one account exhausted another account's challenges")
	}
}
