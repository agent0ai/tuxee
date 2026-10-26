package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestProxyOriginAdmission(t *testing.T) {
	for _, tc := range []struct {
		name, host, origin, site, configured string
		allowed                              bool
	}{
		{name: "HTTP", origin: "http://tuxee.test", allowed: true},
		{name: "TLS termination", origin: "https://tuxee.test", allowed: true},
		{name: "browser TLS termination", origin: "https://tuxee.test", site: "same-origin", allowed: true},
		{name: "custom public port", host: "tuxee.test:8443", origin: "https://tuxee.test:8443", allowed: true},
		{name: "browser with rewritten backend host", host: "internal:80", origin: "https://tuxee.test", site: "same-origin", allowed: true},
		{name: "existing public URL override", host: "internal:80", origin: "https://tuxee.test", configured: "https://tuxee.test", allowed: true},
		{name: "non-browser", allowed: true},
		{name: "direct browser", site: "none", allowed: true},
		{name: "foreign origin", origin: "https://evil.test"},
		{name: "other port", origin: "https://tuxee.test:8443"},
		{name: "null origin", origin: "null"},
		{name: "malformed origin", origin: "https://["},
		{name: "cross-site", origin: "https://evil.test", site: "cross-site"},
		{name: "same-site is not same-origin", origin: "https://other.tuxee.test", site: "same-site"},
		{name: "cross-scheme browser", origin: "http://tuxee.test", site: "cross-site"},
		{name: "missing origin on cross-site request", site: "cross-site"},
		{name: "unexpected browser metadata", site: "invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := New("test-instance", nil, nil, nil, tc.configured, fstest.MapFS{})
			for _, method := range []string{"GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"} {
				r := httptest.NewRequest(method, "http://tuxee.test/api/connection", nil)
				if tc.host != "" {
					r.Host = tc.host
				}
				r.Header.Set("Origin", tc.origin)
				r.Header.Set("Sec-Fetch-Site", tc.site)
				// Forwarded headers cannot authorize a different origin, including WS GETs.
				r.Header.Set("X-Forwarded-Host", "evil.test")
				r.Header.Set("X-Forwarded-Proto", "https")
				r.Header.Set("Forwarded", "proto=https;host=evil.test")
				r.Header.Set("Upgrade", "websocket")
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				want := http.StatusForbidden
				if tc.allowed {
					want = http.StatusUnauthorized
					if method == "GET" {
						want = http.StatusOK
					}
				}
				if w.Code != want || r.Method != method {
					t.Fatalf("%s: status %d, want %d; request method %s", method, w.Code, want, r.Method)
				}
			}
		})
	}
}

func TestPublicScheme(t *testing.T) {
	for _, tc := range []struct{ request, origin, forwarded, want string }{
		{"http://tuxee.test/", "", "", "http://tuxee.test"},
		{"https://tuxee.test/", "", "http", "https://tuxee.test"},
		{"http://tuxee.test/", "https://tuxee.test", "", "https://tuxee.test"},
		{"http://tuxee.test/", "https://tuxee.test", "http", "https://tuxee.test"},
		{"http://tuxee.test/", "", "https", "https://tuxee.test"},
		{"http://tuxee.test/", "", "invalid", "http://tuxee.test"},
	} {
		s := New("test-instance", nil, nil, nil, "", fstest.MapFS{})
		r := httptest.NewRequest("POST", tc.request, nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-Forwarded-Proto", tc.forwarded)
		if got := s.origin(r); got != tc.want {
			t.Fatalf("%+v: got %q", tc, got)
		}
	}
}
