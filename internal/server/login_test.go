package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"tuxee/internal/i18n"
	"tuxee/internal/identity"
	"tuxee/web"
)

func TestAnonymousAssetsRequireSession(t *testing.T) {
	s := New("test-instance", nil, nil, nil, "", web.Assets())
	paths := []string{"/missing", "/assets/", "/licenses/", "/assets/../index.html", "/./index.html", "/api", "/index.html/", "/login/../index.html"}
	if err := fs.WalkDir(s.Assets, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && path != "index.html" && path != "favicon.png" && path != "social-preview.jpg" && path != "login-logo.webp" {
			paths = append(paths, "/"+path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		for _, method := range []string{"GET", "HEAD", "POST", "OPTIONS"} {
			for _, cookie := range []string{"", "invalid"} {
				r := httptest.NewRequest(method, "http://tuxee.test"+path, nil)
				r.Header.Set("Range", "bytes=0-31")
				if cookie != "" {
					r.AddCookie(&http.Cookie{Name: s.cookieName, Value: cookie})
				}
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				if w.Code != 404 || w.Body.String() != "404 page not found\n" || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Header().Get("Content-Security-Policy"), s.scriptHash) {
					t.Fatalf("anonymous asset disclosure: %s %s %d %v", method, path, w.Code, w.Header())
				}
			}
		}
	}
	for _, path := range []string{"/api/system", "/api/update", "/api/me", "/api/metrics", "/api/tls", "/api/unknown-future-endpoint", "/api/terminals/a/display/ws"} {
		for _, method := range []string{"GET", "HEAD", "POST", "OPTIONS", "DELETE"} {
			r := httptest.NewRequest(method, "http://tuxee.test"+path, nil)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			expected := httptest.NewRecorder()
			failure(expected, 401, i18n.New("backend.server.signInToContinue"))
			if w.Code != expected.Code || w.Body.String() != expected.Body.String() {
				t.Fatalf("endpoint existence leaked: %s %s: %d %s", method, path, w.Code, w.Body)
			}
		}
	}
	for _, path := range []string{"/sw.js", "/script-csp.txt", "/licenses/THIRD_PARTY_NOTICES.md"} {
		r := assetRequest(t, s, "GET", path)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("authenticated asset unavailable: %s %d", path, w.Code)
		}
		s.Close()
		w = httptest.NewRecorder()
		s.closed.Store(false)
		s.ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatalf("revoked session admitted: %s %d", path, w.Code)
		}
	}
	r := assetRequest(t, s, "GET", "/sw.js")
	s.logins[sha256.Sum256([]byte("asset-token"))].expires = time.Now().Add(-time.Second)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatal("expired session admitted to private assets")
	}
}

func TestAnonymousFrontendFailureIsLocalized(t *testing.T) {
	s := New("test-instance", nil, nil, nil, "", fstest.MapFS{})
	s.Translations = i18n.NewStore(t.TempDir())
	for _, language := range []string{"en", "cs"} {
		r := httptest.NewRequest("GET", "http://tuxee.test/", nil)
		r.AddCookie(&http.Cookie{Name: s.languageCookie, Value: language})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 500 || w.Body.String() != s.Translations.Bundle(language, s.languageCookie).Texts["server.frontendUnavailable"]+"\n" {
			t.Fatal("frontend failure lost its translation", w.Code, w.Body.String())
		}
	}
}

func anonymousSurface(t *testing.T, s *Server) map[string]string {
	t.Helper()
	result := map[string]string{}
	record := func(name, method, path, body, language string, headers map[string]string) {
		t.Helper()
		r := httptest.NewRequest(method, "http://tuxee.test"+path, strings.NewReader(body))
		if language != "" {
			r.AddCookie(&http.Cookie{Name: s.languageCookie, Value: language})
		}
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		data, err := json.Marshal(struct {
			Status int
			Header http.Header
			Body   []byte
		}{w.Code, w.Result().Header, w.Body.Bytes()})
		if err != nil {
			t.Fatal(err)
		}
		result[name] = fmt.Sprintf("%x", sha256.Sum256(data))
		if bytes.Contains(w.Body.Bytes(), []byte(s.Version)) || bytes.Contains(w.Body.Bytes(), []byte("tuxee-hostname")) || bytes.Contains(w.Body.Bytes(), []byte("tuxee-version")) {
			t.Fatal("anonymous identity disclosure", name)
		}
	}
	for _, language := range s.Translations.Bundle("en", s.languageCookie).Languages {
		record("index/"+language.Code, "GET", "/", "", language.Code, nil)
		record("language/"+language.Code, "GET", "/api/language?language="+language.Code, "", "", nil)
	}
	for _, path := range []string{"/", "/index.html", "/login-logo.webp", "/favicon.png", "/social-preview.jpg", "/health", "/api/connection", "/api/language?language=unknown", "/api/system", "/api/update", "/api/me", "/api/missing", "/sw.js", "/script-csp.txt", "/login-csp.txt", "/login.html", "/licenses/", "/assets/", "/missing"} {
		for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
			record(method+" "+path, method, path, "", "", nil)
		}
	}
	record("gzip", "GET", "/", "", "", map[string]string{"Accept-Encoding": "gzip"})
	record("range", "GET", "/login-logo.webp", "", "", map[string]string{"Range": "bytes=0-31"})
	record("login/header", "POST", "/api/login", "{}", "", nil)
	for _, body := range []string{"{", "{} {}", `{"unknown":true}`, `{"username":"","password":""}`} {
		record("login/"+body, "POST", "/api/login", body, "", map[string]string{"X-Tuxee-Client": "web"})
	}
	record("origin", "POST", "/api/login", "{}", "", map[string]string{"Origin": "http://evil.test"})
	s.Close()
	record("shutdown", "GET", "/api/connection", "", "", nil)
	return result
}

func TestAnonymousReleaseIndependence(t *testing.T) {
	assets := web.Assets()
	first := New("test-instance", identity.NewGate("login"), nil, nil, "", assets)
	first.Version = "0.12.1"
	first.Translations = i18n.NewStore(t.TempDir())
	want := anonymousSurface(t, first)

	// Model a new release with different app code, CSP, assets, dependencies and catalogs.
	next := fstest.MapFS{}
	if err := fs.WalkDir(assets, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			data, err := fs.ReadFile(assets, path)
			if err != nil {
				return err
			}
			next[path] = &fstest.MapFile{Data: data}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	next["index.html"] = &fstest.MapFile{Data: []byte("new application 0.13.0")}
	hash := sha256.Sum256([]byte("new script"))
	next["script-csp.txt"] = &fstest.MapFile{Data: []byte(base64.StdEncoding.EncodeToString(hash[:]))}
	next["assets/new-release.js"] = &fstest.MapFile{Data: []byte("new dependency")}
	next["licenses/THIRD_PARTY_NOTICES.md"] = &fstest.MapFile{Data: []byte("new license versions")}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "en.json"), []byte(`{"texts":{"app.newFeature":"New feature","app.loading":"Changed private text"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	second := New("test-instance", identity.NewGate("login"), nil, nil, "", next)
	second.Version = "0.13.0"
	second.Translations = i18n.NewStore(dir)
	if got := anonymousSurface(t, second); !reflect.DeepEqual(got, want) {
		t.Fatal("application update changed the anonymous surface")
	}

	data, err := json.MarshalIndent(want, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	path := "testdata/login-surface.json"
	if os.Getenv("TUXEE_UPDATE_LOGIN_BASELINE") == "1" {
		if err := os.MkdirAll("testdata", 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	baseline, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, baseline) {
		t.Fatal("anonymous release contract changed; inspect the public response change, do not routinely regenerate testdata/login-surface.json")
	}
}
