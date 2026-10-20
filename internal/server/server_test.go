package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"tuxee/internal/identity"
	"tuxee/internal/terminal"
)

func TestSessionAdmissionAndLogout(t *testing.T) {
	manager := terminal.NewManager()
	defer manager.Close()
	s := New(identity.NewGate("login"), manager, nil, "", fstest.MapFS{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.logins[sha256.Sum256([]byte("token"))] = &login{csrf: "csrf", ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	request := func(method, path, origin, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://tuxee.test"+path, nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Tuxee-CSRF", csrf)
		r.AddCookie(&http.Cookie{Name: "tuxee_session", Value: "token"})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if got := request("POST", "/api/logout", "http://evil.test", "csrf").Code; got != 403 {
		t.Fatalf("cross origin: %d", got)
	}
	if got := request("POST", "/api/logout", "http://tuxee.test", "").Code; got != 403 {
		t.Fatalf("missing csrf: %d", got)
	}
	if got := request("POST", "/api/logout", "http://tuxee.test", "csrf").Code; got != 200 {
		t.Fatalf("logout: %d", got)
	}
	if ctx.Err() == nil {
		t.Fatal("logout did not cancel transports")
	}
	if got := request("GET", "/api/terminals", "", "").Code; got != 401 {
		t.Fatalf("revoked cookie: %d", got)
	}
}
func TestShutdownReportsUnavailableBeforeRevokingSessions(t *testing.T) {
	s := New(nil, nil, nil, "", fstest.MapFS{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.logins[sha256.Sum256([]byte("token"))] = &login{ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	health := httptest.NewRecorder()
	s.ServeHTTP(health, httptest.NewRequest("GET", "/health", nil))
	if health.Code != 200 || health.Body.String() != "ok" || health.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("ready health: %d %q", health.Code, health.Body.String())
	}
	s.Close()
	if ctx.Err() == nil {
		t.Fatal("shutdown did not cancel the session")
	}
	for _, path := range []string{"/health", "/api/me", "/api/terminals", "/api/login", "/"} {
		for _, cookie := range []bool{false, true} {
			r := httptest.NewRequest("GET", path, nil)
			if path == "/api/login" {
				r.Method = "POST"
			}
			if cookie {
				r.AddCookie(&http.Cookie{Name: "tuxee_session", Value: "token"})
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			var body map[string]string
			if w.Code != 503 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body["error"] != "server restarting" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("shutdown %s (cookie=%v): %d %q", path, cookie, w.Code, w.Body.String())
			}
			if len(w.Result().Cookies()) != 0 {
				t.Fatal("shutdown issued a login cookie")
			}
		}
	}
	s.Close()
}
func TestSettingsWholeGridValidation(t *testing.T) {
	if validateSettings(Settings{Theme: "dark"}) == nil {
		t.Fatal("accepted null workspace list")
	}
	value := Settings{Theme: "dark", Current: "ws", Workspaces: []Workspace{{ID: "ws", Name: "Workspace", Columns: 4, Rows: 2, Panels: []Panel{{ID: "a", Kind: "files", W: 2, H: 2}, {ID: "b", Kind: "terminal", X: 2, W: 2, H: 2}}}}}
	if err := validateSettings(value); err != nil {
		t.Fatal(err)
	}
	value.Workspaces[0].Panels[1].X = 1
	if err := validateSettings(value); err == nil {
		t.Fatal("accepted overlapping panels")
	}
	value.Workspaces[0].Panels[1].X = 3
	if err := validateSettings(value); err == nil {
		t.Fatal("accepted out of bounds panel")
	}
}
func TestSettingsLayoutCycle(t *testing.T) {
	value := Settings{Theme: "dark", Current: "ws", Workspaces: []Workspace{{ID: "ws", Name: "Workspace", Columns: 4, Rows: 2, Panels: []Panel{{ID: "a", Kind: "files", W: 1, H: 2}, {ID: "b", Kind: "terminal", X: 1, W: 3, H: 2}}}}}
	valid := []PanelPosition{{ID: "a", W: 2, H: 2}, {ID: "b", X: 2, W: 2, H: 2}}
	for mode := 1; mode <= 3; mode++ {
		value.Workspaces[0].Layout = &Layout{Mode: mode, Custom: valid}
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var restored Settings
		if err = json.Unmarshal(data, &restored); err != nil {
			t.Fatal(err)
		}
		if err = validateSettings(restored); err != nil {
			t.Fatal(err)
		}
		if restored.Workspaces[0].Layout.Mode != mode || restored.Workspaces[0].Layout.Custom[0] != valid[0] {
			t.Fatal("lost custom layout or cycle mode")
		}
	}
	for _, layout := range []Layout{
		{Mode: 0, Custom: valid}, {Mode: 4, Custom: valid}, {Mode: 1},
		{Mode: 1, Custom: valid[:1]},
		{Mode: 1, Custom: []PanelPosition{valid[0], valid[0]}},
		{Mode: 1, Custom: []PanelPosition{valid[0], {ID: "unknown", X: 2, W: 2, H: 2}}},
		{Mode: 1, Custom: []PanelPosition{valid[0], {ID: "b", X: 1, W: 2, H: 2}}},
		{Mode: 1, Custom: []PanelPosition{valid[0], {ID: "b", X: 3, W: 2, H: 2}}},
		{Mode: 1, Custom: []PanelPosition{valid[0], {ID: "b", X: 2, W: int(^uint(0) >> 1), H: 2}}},
		{Mode: 1, Custom: []PanelPosition{valid[0], {ID: "b", X: 2, W: 0, H: 2}}},
	} {
		value.Workspaces[0].Layout = &layout
		if validateSettings(value) == nil {
			t.Fatalf("accepted invalid layout: %+v", layout)
		}
	}
	value.Workspaces[0].Layout = nil
	if err := validateSettings(value); err != nil {
		t.Fatal("legacy/custom workspace rejected:", err)
	}
}
func TestFileBrowserNames(t *testing.T) {
	value := Settings{Theme: "dark", Current: "ws", Workspaces: []Workspace{{ID: "ws", Name: "Workspace", Columns: 4, Rows: 2, Panels: []Panel{{ID: "files", Kind: "files", W: 1, H: 1}}}}}
	panel := &value.Workspaces[0].Panels[0]
	for _, name := range []string{"", "Projects — server", strings.Repeat("x", 80)} {
		panel.Name = name
		if err := validateSettings(value); err != nil {
			t.Fatalf("valid browser name rejected: %v", err)
		}
	}
	for _, name := range []string{strings.Repeat("x", 81), "bad\x00name"} {
		panel.Name = name
		if validateSettings(value) == nil {
			t.Fatal("invalid browser name accepted")
		}
	}
	panel.Kind, panel.Name = "terminal", "Duplicate name source"
	if validateSettings(value) == nil {
		t.Fatal("terminal names must remain owned by the terminal session")
	}
	panel.Name = ""
	if err := validateSettings(value); err != nil {
		t.Fatal("legacy terminal settings rejected:", err)
	}
}
func TestOriginAndRequestValidation(t *testing.T) {
	for _, origin := range []string{"https://example.test", "http://localhost:1234", ""} {
		if err := ValidateOrigin(origin); err != nil {
			t.Fatal(err)
		}
	}
	for _, origin := range []string{"//example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?q=1"} {
		if ValidateOrigin(origin) == nil {
			t.Fatalf("accepted %q", origin)
		}
	}
	for _, data := range []string{`{"x":1} {"x":2}`, `{"wrong":1}`} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(data))
		var value struct {
			X int `json:"x"`
		}
		if decode(httptest.NewRecorder(), r, &value) == nil {
			t.Fatalf("accepted %s", data)
		}
	}
}
