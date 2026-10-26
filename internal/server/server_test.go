package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"tuxee/internal/identity"
	"tuxee/internal/processes"
	"tuxee/internal/terminal"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "__processes" {
		if processes.Worker() != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestSessionAdmissionAndLogout(t *testing.T) {
	manager := terminal.NewManager()
	defer manager.Close()
	s := New("test-instance", identity.NewGate("login"), manager, nil, "", fstest.MapFS{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.logins[sha256.Sum256([]byte("token"))] = &login{csrf: "csrf", ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	request := func(method, path, origin, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://tuxee.test"+path, nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Tuxee-CSRF", csrf)
		r.AddCookie(&http.Cookie{Name: s.cookieName, Value: "token"})
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

func TestInstanceCookiesShareHostWithoutSharingSessions(t *testing.T) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	var instances []*Server
	var addresses []*url.URL
	var sessions []context.Context
	for _, id := range []string{"instance-a", "instance-b"} {
		s := New(id, nil, nil, nil, "", fstest.MapFS{})
		t.Cleanup(s.Close)
		ctx, cancel := context.WithCancel(context.Background())
		s.logins[sha256.Sum256([]byte("token"))] = &login{csrf: id, ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
		httpServer := httptest.NewServer(s)
		t.Cleanup(httpServer.Close)
		address, err := url.Parse(httpServer.URL)
		if err != nil {
			t.Fatal(err)
		}
		instances = append(instances, s)
		addresses = append(addresses, address)
		sessions = append(sessions, ctx)
	}
	check := func(index int, want bool) {
		t.Helper()
		response, err := client.Get(addresses[index].String() + "/api/connection")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var state struct {
			Authenticated bool `json:"authenticated"`
		}
		if response.StatusCode != 200 || json.NewDecoder(response.Body).Decode(&state) != nil || state.Authenticated != want {
			t.Fatalf("instance %d authentication = %v, want %v", index, state.Authenticated, want)
		}
	}
	jar.SetCookies(addresses[0], []*http.Cookie{{Name: "tuxee_session", Value: "token", Path: "/"}})
	check(0, false)
	check(1, false)
	jar.SetCookies(addresses[0], []*http.Cookie{{Name: instances[0].cookieName, Value: "token", Path: "/"}})
	check(0, true)
	check(1, false)
	jar.SetCookies(addresses[1], []*http.Cookie{{Name: instances[1].cookieName, Value: "token", Path: "/"}})
	check(0, true)
	check(1, true)
	request, err := http.NewRequest("POST", addresses[0].String()+"/api/logout", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Tuxee-CSRF", "instance-a")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	cookies := response.Cookies()
	if response.StatusCode != 200 || len(cookies) != 1 || cookies[0].Name != instances[0].cookieName || cookies[0].MaxAge != -1 {
		t.Fatal("logout must clear only its instance cookie")
	}
	check(0, false)
	check(1, true)
	if sessions[0].Err() == nil || sessions[1].Err() != nil {
		t.Fatal("logout must revoke only its own transports")
	}
}

func TestRestartAdmission(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root to check both allowed and denied Linux credentials")
	}
	for _, tc := range []struct {
		name, method, origin, csrf   string
		uid                          uint32
		anonymous, unavailable, busy bool
		want                         int
	}{
		{name: "anonymous", method: "POST", anonymous: true, want: 401},
		{name: "no signal permission", method: "POST", csrf: "csrf", uid: 65534, want: 403},
		{name: "cross-origin", method: "POST", csrf: "csrf", origin: "http://evil.test", want: 403},
		{name: "missing CSRF", method: "POST", want: 403},
		{name: "GET cannot restart", method: "GET", want: 404},
		{name: "unavailable", method: "POST", csrf: "csrf", unavailable: true, want: 503},
		{name: "busy", method: "POST", csrf: "csrf", busy: true, want: 429},
		{name: "signal permitted", method: "POST", csrf: "csrf", want: 202},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := New("test-instance", nil, nil, nil, "", fstest.MapFS{})
			defer s.Close()
			if tc.busy {
				s.processKills <- struct{}{}
				s.processKills <- struct{}{}
			}
			ctx, cancel := context.WithCancel(context.Background())
			s.logins[sha256.Sum256([]byte("token"))] = &login{user: identity.User{UID: tc.uid}, csrf: "csrf", ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
			calls := 0
			if !tc.unavailable {
				s.Restart = func() { calls++ }
			}
			r := httptest.NewRequest(tc.method, "http://tuxee.test/api/restart", nil)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-Tuxee-CSRF", tc.csrf)
			if !tc.anonymous {
				r.AddCookie(&http.Cookie{Name: s.cookieName, Value: "token"})
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != tc.want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("restart: %d %s", w.Code, w.Body.String())
			}
			if tc.uid != 0 && !strings.Contains(w.Body.String(), "operation not permitted") {
				t.Fatalf("missing Linux permission error: %s", w.Body.String())
			}
			if tc.want != 202 {
				if calls != 0 || s.closed.Load() {
					t.Fatal("rejected restart changed the runtime")
				}
				return
			}
			if calls != 1 || !s.closed.Load() || w.Body.String() != "{\"ok\":true}\n" {
				t.Fatal("restart was not accepted exactly once")
			}
			for _, path := range []string{"/api/restart", "/api/connection", "/health"} {
				r.URL.Path = path
				w = httptest.NewRecorder()
				s.ServeHTTP(w, r)
				if w.Code != 503 || calls != 1 {
					t.Fatal("restart must report unavailable and reject duplicate requests")
				}
			}
			s.Close()
			if ctx.Err() == nil {
				t.Fatal("runtime cleanup did not revoke the old session")
			}
		})
	}
}

func TestConnectionReadinessIncludesAuthentication(t *testing.T) {
	s := New("test-instance", nil, nil, nil, "", fstest.MapFS{})
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	s.logins[sha256.Sum256([]byte("token"))] = &login{user: identity.User{UID: 1234}, csrf: "csrf", ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	expired, expire := context.WithCancel(context.Background())
	s.logins[sha256.Sum256([]byte("expired"))] = &login{ctx: expired, cancel: expire, expires: time.Now().Add(-time.Hour)}
	for _, token := range []string{"", "invalid", "token", "expired"} {
		r := httptest.NewRequest("GET", "/api/connection", nil)
		if token != "" {
			r.AddCookie(&http.Cookie{Name: s.cookieName, Value: token})
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var state struct {
			Authenticated bool   `json:"authenticated"`
			UID           *int   `json:"uid"`
			CSRF          string `json:"csrf"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil || state.Authenticated != (token == "token") || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("connection with cookie %q: %d %s", token, w.Code, w.Body.String())
		}
		if state.Authenticated {
			if state.UID == nil || *state.UID != 1234 || state.CSRF != "csrf" {
				t.Fatal("authenticated readiness must identify the account and current request token")
			}
		} else if state.UID != nil || state.CSRF != "" {
			t.Fatal("anonymous readiness must omit account and request token")
		}
	}
	if expired.Err() == nil {
		t.Fatal("expired login was not revoked")
	}
}
func TestShutdownReportsUnavailableBeforeRevokingSessions(t *testing.T) {
	s := New("test-instance", nil, nil, nil, "", fstest.MapFS{})
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
	for _, path := range []string{"/health", "/api/connection", "/api/me", "/api/terminals", "/api/login", "/"} {
		for _, cookie := range []bool{false, true} {
			r := httptest.NewRequest("GET", path, nil)
			if path == "/api/login" {
				r.Method = "POST"
			}
			if cookie {
				r.AddCookie(&http.Cookie{Name: s.cookieName, Value: "token"})
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
func TestServerColorMarker(t *testing.T) {
	for _, color := range []string{"", "#000000", "#ffffff", "#aBc123"} {
		value := Settings{Theme: "dark", Workspaces: []Workspace{}, ServerColor: color}
		if err := validateSettings(&value); err != nil {
			t.Fatalf("valid color %q rejected: %v", color, err)
		}
		data, _ := json.Marshal(value)
		var restored Settings
		if err := json.Unmarshal(data, &restored); err != nil || restored.ServerColor != color {
			t.Fatalf("color did not round-trip: %s, %v", data, err)
		}
		if color == "" && strings.Contains(string(data), "serverColor") {
			t.Fatal("reset color marker should be omitted from settings")
		}
	}
	for _, color := range []string{"red", "#abc", "123456", "#12345678", "#gg0000", "#123456 ", "#123456; color:red", "var(--line)"} {
		value := Settings{Theme: "dark", Workspaces: []Workspace{}, ServerColor: color}
		if validateSettings(&value) == nil {
			t.Fatalf("accepted invalid color %q", color)
		}
	}
}

func TestServerDisplayName(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"", ""}, {" \t\n", ""}, {"  Lab <&> 東京 \u00a0", "Lab <&> 東京"},
		{strings.Repeat("é", 64), strings.Repeat("é", 64)},
		{strings.Repeat("🐧", 32), strings.Repeat("🐧", 32)},
	} {
		value := Settings{Theme: "dark", Workspaces: []Workspace{}, ServerName: test.input}
		if err := validateSettings(&value); err != nil || value.ServerName != test.want {
			t.Fatalf("server name %q: got %q, error %v", test.input, value.ServerName, err)
		}
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if test.want == "" && strings.Contains(string(data), "serverName") {
			t.Fatal("empty server name should be omitted from settings")
		}
	}
	for _, name := range []string{strings.Repeat("a", 65), strings.Repeat("é", 65), strings.Repeat("🐧", 33), "bad\x00name"} {
		value := Settings{Theme: "dark", Workspaces: []Workspace{}, ServerName: name}
		if validateSettings(&value) == nil {
			t.Fatalf("accepted invalid server name %q", name)
		}
	}
}

func TestSettingsWholeGridValidation(t *testing.T) {
	if validateSettings(&Settings{Theme: "dark"}) == nil {
		t.Fatal("accepted null workspace list")
	}
	value := Settings{Theme: "dark", Current: "ws", Workspaces: []Workspace{{ID: "ws", Name: "Workspace", Columns: 4, Rows: 2, Panels: []Panel{{ID: "a", Kind: "files", W: 2, H: 2}, {ID: "b", Kind: "terminal", X: 2, W: 2, H: 2}}}}}
	if err := validateSettings(&value); err != nil {
		t.Fatal(err)
	}
	value.Workspaces[0].Panels[1].X = 1
	if err := validateSettings(&value); err == nil {
		t.Fatal("accepted overlapping panels")
	}
	value.Workspaces[0].Panels[1].X = 3
	if err := validateSettings(&value); err == nil {
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
		if err = validateSettings(&restored); err != nil {
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
		if validateSettings(&value) == nil {
			t.Fatalf("accepted invalid layout: %+v", layout)
		}
	}
	value.Workspaces[0].Layout = nil
	if err := validateSettings(&value); err != nil {
		t.Fatal("legacy/custom workspace rejected:", err)
	}
}
func TestLegacyFileBrowserNamesAreIgnored(t *testing.T) {
	var value Settings
	if err := json.Unmarshal([]byte(`{"theme":"dark","current":"ws","workspaces":[{"id":"ws","name":"Workspace","columns":4,"rows":2,"panels":[{"id":"files","kind":"files","path":"/tmp","name":"Old alias","w":1,"h":1}]}]}`), &value); err != nil {
		t.Fatal(err)
	}
	if err := validateSettings(&value); err != nil {
		t.Fatal(err)
	}
	panel, err := json.Marshal(value.Workspaces[0].Panels[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(panel), `"name"`) || value.Workspaces[0].Panels[0].Path != "/tmp" {
		t.Fatalf("legacy alias retained or path changed: %s", panel)
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
