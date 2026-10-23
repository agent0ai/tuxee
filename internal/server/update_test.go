package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"tuxee/internal/identity"
	"tuxee/internal/update"
)

func TestUpdateChecksRequireSessionAndCSRF(t *testing.T) {
	s := New(nil, nil, nil, "", fstest.MapFS{})
	s.Updates = update.NewChecker("1.0.0")
	request := func(method string, authenticated, csrf bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://tuxee.test/api/update", nil)
		r.Header.Set("X-Tuxee-Client", "web")
		if authenticated {
			r.AddCookie(&http.Cookie{Name: "tuxee_session", Value: "token"})
		}
		if csrf {
			r.Header.Set("X-Tuxee-CSRF", "csrf")
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", false, false); w.Code != 401 {
		t.Fatal(w.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.logins[sha256.Sum256([]byte("token"))] = &login{user: identity.User{UID: 60001}, csrf: "csrf", ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	if w := request("POST", true, false); w.Code != 403 {
		t.Fatal(w.Code)
	}
	w := request("GET", true, false)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Header())
	}
	var status struct {
		Current, Command string
		Available        bool
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Current != "1.0.0" || status.Available || !strings.HasPrefix(status.Command, "sudo '") || !strings.HasSuffix(status.Command, "' update") {
		t.Fatal(status)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.Symlink(executable, filepath.Join(dir, "tuxee")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	w = request("GET", true, false)
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil || status.Command != "sudo tuxee update" {
		t.Fatal("matching PATH", status, err)
	}
	s.logins[sha256.Sum256([]byte("token"))].user.UID = 0
	w = request("GET", true, false)
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil || status.Command != "tuxee update" {
		t.Fatal("root command", status, err)
	}
	if w := request("PUT", true, true); w.Code != 404 {
		t.Fatal("unexpected update mutation", w.Code)
	}
}
