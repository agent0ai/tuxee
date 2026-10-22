package server

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"
	"tuxee/internal/terminal"
)

func TestDisplayAdmission(t *testing.T) {
	s := New(nil, terminal.NewManager(), nil, "", fstest.MapFS{})
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	s.logins[sha256.Sum256([]byte("token"))] = &login{csrf: "csrf", ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	for _, tc := range []struct {
		method, path, token, origin, csrf string
		status                            int
	}{
		{"GET", "/api/audio", "", "http://tuxee.test", "", 401},
		{"GET", "/api/audio", "token", "", "", 403},
		{"GET", "/api/audio", "token", "http://evil.test", "", 403},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display", "", "", "", 401},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/ws", "", "http://tuxee.test", "", 401},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display", "token", "http://tuxee.test", "", 403},
		{"POST", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display", "token", "http://evil.test", "csrf", 403},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/ws", "token", "", "", 404},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/ws", "token", "http://evil.test", "", 403},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/ws", "token", "http://tuxee.test", "", 404},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display", "token", "http://tuxee.test", "", 404},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/audio", "", "http://tuxee.test", "", 401},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/audio", "token", "http://evil.test", "", 403},
		{"GET", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/audio", "token", "http://tuxee.test", "", 404},
		{"DELETE", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/window", "", "http://tuxee.test", "csrf", 401},
		{"DELETE", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/window", "token", "http://tuxee.test", "", 403},
		{"DELETE", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/window", "token", "http://evil.test", "csrf", 403},
		{"DELETE", "/api/terminals/aaaaaaaaaaaaaaaaaaaaaaaa/display/window", "token", "http://tuxee.test", "csrf", 404},
	} {
		r := httptest.NewRequest(tc.method, "http://tuxee.test"+tc.path, nil)
		r.AddCookie(&http.Cookie{Name: "tuxee_session", Value: tc.token})
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-Tuxee-CSRF", tc.csrf)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s origin=%q: %d, want %d", tc.method, tc.path, tc.origin, w.Code, tc.status)
		}
	}
}
