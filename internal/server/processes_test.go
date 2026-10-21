package server

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"tuxee/internal/processes"
)

func TestProcessAdmissionAndSnapshotTargets(t *testing.T) {
	s := New(nil, nil, nil, "", fstest.MapFS{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := &login{ctx: ctx, cancel: cancel, csrf: "csrf", expires: time.Now().Add(time.Hour)}
	s.logins[sha256.Sum256([]byte("owner"))] = session
	s.logins[sha256.Sum256([]byte("other"))] = &login{ctx: ctx, cancel: cancel, csrf: "csrf", expires: time.Now().Add(time.Hour)}
	request := func(method, path, cookie, csrf, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://tuxee.test"+path, strings.NewReader(body))
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: "tuxee_session", Value: cookie})
		}
		r.Header.Set("X-Tuxee-CSRF", csrf)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/api/processes", "", "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := request("POST", "/api/processes", "owner", "", `{}`); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := request("GET", "/api/processes?sort=invalid", "owner", "", ""); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := request("POST", "/api/processes", "owner", "csrf", `{"snapshot":"x","selected":["p:42"],"signal":-9}`); w.Code != 400 {
		t.Fatal(w.Code)
	}
	data := &processes.Snapshot{Time: time.Now()}
	for i := 2; i < 2002; i++ {
		data.Processes = append(data.Processes, processes.Process{Ref: processes.Ref{PID: i, Start: fmt.Sprint(i)}, Parent: 1, Name: "test", State: "S", RAM: uint64(i), CanSignal: true})
	}
	current := &processSnapshot{id: "snapshot", data: data, view: data.View("ram")}
	session.processSnapshot = current
	group := current.view.Rows[len(current.view.Rows)-1]
	if !group.Group {
		t.Fatal("missing group")
	}
	refs, err := current.targets([]string{group.ID})
	if err != nil || len(refs) != 1901 {
		t.Fatalf("group targeting: %d %v", len(refs), err)
	}
	if _, err = current.targets([]string{"p:999999"}); err == nil {
		t.Fatal("accepted hidden arbitrary PID")
	}
	if w := request("POST", "/api/processes", "other", "csrf", `{"snapshot":"snapshot","selected":["p:42"],"signal":15}`); w.Code != 409 {
		t.Fatal("cross-session snapshot", w.Code)
	}
	if w := request("DELETE", "/api/processes?snapshot=other", "owner", "csrf", ""); w.Code != 200 || session.processSnapshot == nil {
		t.Fatal("deleted wrong snapshot")
	}
	if w := request("DELETE", "/api/processes?snapshot=snapshot", "owner", "csrf", ""); w.Code != 200 || session.processSnapshot != nil {
		t.Fatal("did not release snapshot")
	}
}
