package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"tuxee/internal/tlsmanager"
)

func TestTLSStatusDescribesRequestInsteadOfAvailableCertificate(t *testing.T) {
	manager, err := tlsmanager.New(tlsmanager.Options{Directory: t.TempDir(), Hosts: []string{"default.test"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, scheme, sni, header, source, host string
		unmanaged, anonymous                    bool
	}{
		{name: "HTTP with HTTPS also enabled", scheme: "http", source: "http"},
		{name: "TLS terminated before HTTP backend", scheme: "http", header: "X-Forwarded-Proto", source: "http"},
		{name: "direct TLS uses SNI instead of HTTP Host", scheme: "https", sni: "sni.test", source: "local", host: "sni.test"},
		{name: "direct TLS without SNI uses default certificate", scheme: "https", source: "local", host: "default.test"},
		{name: "proxy re-encryption", scheme: "https", header: "X-Forwarded-Proto", source: "https"},
		{name: "forwarded client", scheme: "https", header: "X-Forwarded-For", source: "https"},
		{name: "forwarded host", scheme: "https", header: "X-Forwarded-Host", source: "https"},
		{name: "standard forwarded header", scheme: "https", header: "Forwarded", source: "https"},
		{name: "via proxy", scheme: "https", header: "Via", source: "https"},
		{name: "unmanaged TLS", scheme: "https", unmanaged: true, source: "https"},
		{name: "HTTP only", scheme: "http", unmanaged: true, source: "http"},
		{name: "anonymous", scheme: "https", anonymous: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := New(nil, nil, manager, "", fstest.MapFS{})
			defer s.Close()
			if tc.unmanaged {
				s.TLS = nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.logins[sha256.Sum256([]byte("token"))] = &login{ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
			r := httptest.NewRequest("GET", tc.scheme+"://http-host.test/api/tls", nil)
			if r.TLS != nil {
				r.TLS.ServerName = tc.sni
			}
			if tc.header != "" {
				r.Header.Set(tc.header, "https")
			}
			if !tc.anonymous {
				r.AddCookie(&http.Cookie{Name: "tuxee_session", Value: "token"})
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if tc.anonymous {
				if w.Code != http.StatusUnauthorized {
					t.Fatalf("anonymous TLS status: %d", w.Code)
				}
				return
			}
			var status map[string]any
			if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &status) != nil || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("TLS status: %d %s", w.Code, w.Body.String())
			}
			if status["source"] != tc.source {
				t.Fatalf("source: %v, want %s", status, tc.source)
			}
			if tc.host == "" {
				if len(status) != 1 {
					t.Fatalf("non-direct connection exposed certificate metadata: %v", status)
				}
			} else if status["host"] != tc.host || status["expires"] == nil {
				t.Fatalf("wrong TLS identity: %v", status)
			}
		})
	}
}
