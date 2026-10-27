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
	"time"
	"tuxee/internal/i18n"
	"tuxee/web"
)

func TestLanguageCookieAndSessionPrecedence(t *testing.T) {
	s := New("language-instance", nil, nil, nil, "", web.Assets())
	s.Translations = i18n.NewStore(t.TempDir())
	request := func(path, language, token string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("GET", "http://local.test"+path, nil)
		if language != "" {
			r.AddCookie(&http.Cookie{Name: s.languageCookie, Value: language})
		}
		if token != "" {
			r.AddCookie(&http.Cookie{Name: s.cookieName, Value: token})
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		return w
	}
	if !strings.Contains(request("/", "", "").Body.String(), `<html lang="en"`) {
		t.Fatal("default language is not English")
	}
	for _, code := range []string{"ar", "fa", "he"} {
		if !strings.Contains(request("/", code, "").Body.String(), `<html lang="`+code+`" dir="rtl"`) {
			t.Fatal("initial RTL direction missing", code)
		}
	}
	cs := request("/", "cs", "")
	if !strings.Contains(cs.Body.String(), `<html lang="cs"`) || !strings.Contains(cs.Body.String(), `"login.username":"Uživatelské jméno"`) {
		t.Fatal("cookie did not select Czech")
	}
	if cs.Header().Get("Cache-Control") != "private, no-store" || !strings.Contains(cs.Header().Get("Vary"), "Cookie") {
		t.Fatal("localized index may enter a shared cache")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.logins[sha256.Sum256([]byte("token"))] = &login{ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour), translations: s.Translations.Bundle("cs", s.languageCookie)}
	if !strings.Contains(request("/", "ar", "token").Body.String(), `<html lang="cs" dir="ltr"`) {
		t.Fatal("preference cookie changed an authenticated language")
	}
	var bundle i18n.Bundle
	if err := json.Unmarshal(request("/api/language?language=en", "en", "token").Body.Bytes(), &bundle); err != nil || bundle.Language != "cs" {
		t.Fatal("language API changed session", err, bundle.Language)
	}
	if err := json.Unmarshal(request("/api/language?language=en", "cs", "").Body.Bytes(), &bundle); err != nil || bundle.Language != "en" {
		t.Fatal("login language selection failed", err)
	}
}

func TestCatalogInjectionPreservesScriptSecurity(t *testing.T) {
	dir := t.TempDir()
	source := `{"texts":{"login.username":"</script><script>window.injected=true</script>{{hostname}}"}}`
	if err := os.WriteFile(filepath.Join(dir, "cs.json"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	s := New("injection-instance", nil, nil, nil, "", web.Assets())
	s.Translations = i18n.NewStore(dir)
	request := httptest.NewRequest("GET", "http://local.test/", nil)
	request.AddCookie(&http.Cookie{Name: s.languageCookie, Value: "cs"})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, request)
	if strings.Contains(w.Body.String(), "<script>window.injected") || !strings.Contains(w.Body.String(), `\u003c/script\u003e`) {
		t.Fatal("catalog must be JSON escaped")
	}
	if !strings.Contains(w.Body.String(), "{{hostname}}") {
		t.Fatal("catalog values were expanded as index templates")
	}
	if strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'self' 'unsafe-inline'") {
		t.Fatal("script policy weakened")
	}
}
