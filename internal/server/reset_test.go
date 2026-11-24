package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tuxee/internal/identity"
	"tuxee/web"
)

func TestResetPageAndLoginReplacement(t *testing.T) {
	s := New("test-instance", nil, nil, nil, "", web.Assets())
	add := func(token string, uid uint32) *login {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		session := &login{ctx: ctx, cancel: cancel, csrf: "csrf-" + token, expires: time.Now().Add(time.Hour), user: identity.User{Name: "alice", UID: uid}, translations: s.Translations.Bundle("en", s.languageCookie)}
		s.logins[sha256.Sum256([]byte(token))] = session
		return session
	}
	owner, sibling, other := add("owner", 1000), add("sibling", 1000), add("other", 1001)
	serve := func(method, path, token, csrf string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "http://tuxee.test"+path, nil)
		if token != "" {
			request.AddCookie(&http.Cookie{Name: s.cookieName, Value: token})
		}
		if csrf != "" {
			request.Header.Set("X-Tuxee-CSRF", csrf)
		}
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		return response
	}

	if response := serve("GET", "/reset", "", ""); response.Code != 404 {
		t.Fatal("anonymous reset page must stay an ordinary 404", response.Code)
	}
	page := serve("GET", "/reset", "owner", "")
	body := page.Body.String()
	if page.Code != 200 || page.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal(page.Code, page.Header())
	}
	if page.Header().Get("Content-Security-Policy") != resetPolicy+resetScriptHash || !strings.Contains(body, "<script>"+resetScript+"</script>") {
		t.Fatal("reset script must match its CSP hash")
	}
	if strings.Contains(body, "<script src") || strings.Contains(body, "/assets/") || !strings.Contains(body, `data-csrf="csrf-owner"`) ||
		!strings.Contains(body, "Reset Tuxee") || !strings.Contains(body, "~/tuxee-backups") || !strings.Contains(body, `data-state="idle"`) {
		t.Fatal("reset page must be standalone and translated", body)
	}

	var status map[string]string
	if response := serve("GET", "/api/reset", "owner", ""); response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &status) != nil || status["state"] != "idle" {
		t.Fatal("idle status", response.Code, response.Body.String())
	}
	if response := serve("POST", "/api/reset", "owner", ""); response.Code != 403 {
		t.Fatal("reset requires the session CSRF token", response.Code)
	}

	// A running job avoids starting a real account worker; the POST still replaces logins.
	s.resets.jobs = map[uint32]*resetJob{1000: {epoch: "epoch", running: true}}
	response := serve("POST", "/api/reset", "owner", "csrf-owner")
	if response.Code != 202 || json.Unmarshal(response.Body.Bytes(), &status) != nil || status["state"] != "running" || status["csrf"] == "" || status["csrf"] == "csrf-owner" {
		t.Fatal(response.Code, response.Body.String())
	}
	var token string
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == s.cookieName {
			token = cookie.Value
		}
	}
	if token == "" || token == "owner" || owner.ctx.Err() == nil || sibling.ctx.Err() == nil || other.ctx.Err() != nil {
		t.Fatal("reset must replace every login of the account and keep other accounts")
	}
	var connection map[string]any
	if response := serve("GET", "/api/connection", token, ""); json.Unmarshal(response.Body.Bytes(), &connection) != nil || connection["reset"] != "epoch" || connection["csrf"] != status["csrf"] {
		t.Fatal("replacement login must report the reset epoch", response.Body.String())
	}
	if response := serve("GET", "/api/connection", "sibling", ""); !strings.Contains(response.Body.String(), `"authenticated":false`) {
		t.Fatal("other browsers of the account must sign in again", response.Body.String())
	}
	if response := serve("GET", "/reset", token, ""); !strings.Contains(response.Body.String(), `data-state="running"`) {
		t.Fatal("reopening the page during a reset must resume progress")
	}

	s.resets.jobs[1000].running, s.resets.jobs[1000].backup = false, "/home/alice/tuxee-backups/x"
	if response := serve("GET", "/api/reset", token, ""); json.Unmarshal(response.Body.Bytes(), &status) != nil || status["state"] != "done" || !strings.Contains(status["message"], "/home/alice/tuxee-backups/x") {
		t.Fatal(response.Body.String())
	}
	s.resets.jobs[1000].err = errors.New("disk full")
	if response := serve("GET", "/api/reset", token, ""); json.Unmarshal(response.Body.Bytes(), &status) != nil || status["state"] != "failed" || !strings.Contains(status["message"], "disk full") {
		t.Fatal(response.Body.String())
	}
}
