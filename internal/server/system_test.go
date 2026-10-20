package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"testing/fstest"
	"time"

	"tuxee/internal/identity"
)

func TestSystemInfoRequiresSessionAndUsesItsUser(t *testing.T) {
	s := New(nil, nil, nil, "", fstest.MapFS{})
	s.Version = "1.2.3-test"
	r := httptest.NewRequest("GET", "http://tuxee.test/api/system", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous system information: %d", w.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	user := identity.User{Name: "signed-in-user", UID: 60001, Home: "/home/signed-in-user", Shell: "/bin/sh"}
	s.logins[sha256.Sum256([]byte("token"))] = &login{user: user, ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	r.AddCookie(&http.Cookie{Name: "tuxee_session", Value: "token"})
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("system information response: %d %v", w.Code, w.Header())
	}
	var info systemInfo
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	hostname, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != s.Version || info.Hostname != hostname || info.OS == "" || info.Kernel == "" || info.Architecture == "" {
		t.Fatalf("missing or incorrect system identity: %+v", info)
	}
	if info.Username != user.Name || info.UID != user.UID || info.Home != user.Home || info.Shell != user.Shell {
		t.Fatalf("system information used the server account instead of the session: %+v", info)
	}
	r.Header.Set("Origin", "http://other.test")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin system information: %d", w.Code)
	}
}

func TestOSReleaseName(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"NAME=Debian\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\n", "Debian GNU/Linux 12 (bookworm)"},
		{"# comment\nPRETTY_NAME='Example Linux'\n", "Example Linux"},
		{"PRETTY_NAME=Linux\n", "Linux"},
		{`PRETTY_NAME="Example \"quoted\" \$name \\ edition"`, `Example "quoted" $name \ edition`},
		{"NAME=Linux\n", ""},
	} {
		if got := osReleaseName(test.input); got != test.want {
			t.Errorf("os-release %q: got %q, want %q", test.input, got, test.want)
		}
	}
}
