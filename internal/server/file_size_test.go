package server

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestSizeAdmission(t *testing.T) {
	s := New("test-instance", nil, nil, nil, "", fstest.MapFS{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.logins[sha256.Sum256([]byte("owner"))] = &login{ctx: ctx, cancel: cancel, csrf: "csrf", expires: time.Now().Add(time.Hour)}
	for _, test := range []struct {
		cookie, csrf, origin string
		status               int
	}{
		{"", "", "", 401},
		{"owner", "", "", 403},
		{"owner", "csrf", "http://evil.test", 403},
		{"owner", "csrf", "", 429},
	} {
		r := httptest.NewRequest("POST", "http://tuxee.test/api/file-size", strings.NewReader(`{"paths":["/"]}`))
		r.AddCookie(&http.Cookie{Name: s.cookieName, Value: test.cookie})
		r.Header.Set("X-Tuxee-CSRF", test.csrf)
		r.Header.Set("Origin", test.origin)
		for len(s.sizeSlots) < cap(s.sizeSlots) {
			s.sizeSlots <- struct{}{}
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("%+v: got %d", test, w.Code)
		}
	}
}
