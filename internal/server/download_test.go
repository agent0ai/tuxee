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

func TestArchiveDownloadOwnershipAndCancellation(t *testing.T) {
	manager := terminal.NewManager()
	defer manager.Close()
	s := New(identity.NewGate("login"), manager, nil, "", fstest.MapFS{})
	defer s.Close()
	for _, token := range []string{"owner", "other"} {
		ctx, cancel := context.WithCancel(context.Background())
		s.logins[sha256.Sum256([]byte(token))] = &login{csrf: "csrf", ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	}
	request := func(method, path, cookie, csrf, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://tuxee.test"+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: "tuxee_session", Value: cookie})
		r.Header.Set("X-Tuxee-CSRF", csrf)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	body := `{"path":"/home/owner","paths":["/home/owner/.config"]}`
	if w := request("POST", "/api/download-archive", "owner", "", body); w.Code != 403 {
		t.Fatal("registration did not require CSRF")
	}
	w := request("POST", "/api/download-archive", "owner", "csrf", body)
	var prepared struct{ Token, Name string }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &prepared) != nil || prepared.Name != ".config.zip" {
		t.Fatal("could not register folder download", w.Body.String())
	}
	job := s.archives[prepared.Token]
	path := "/api/download-archive?token=" + prepared.Token
	for _, method := range []string{"GET", "DELETE"} {
		if request(method, path, "other", "csrf", "").Code != 404 {
			t.Fatal("another session accessed a download")
		}
	}
	if request("GET", "/api/download?archive="+prepared.Token, "other", "", "").Code != 404 {
		t.Fatal("another session claimed the ZIP stream")
	}
	if request("DELETE", path, "owner", "", "").Code != 403 {
		t.Fatal("cancellation did not require CSRF")
	}
	if request("GET", path, "owner", "", "").Code != 200 {
		t.Fatal("owner could not read progress")
	}
	if request("DELETE", path, "owner", "csrf", "").Code != 200 || job.ctx.Err() == nil {
		t.Fatal("cancellation did not stop the download")
	}
	if request("GET", path, "owner", "", "").Code != 404 {
		t.Fatal("cancelled download remains accessible")
	}
}
