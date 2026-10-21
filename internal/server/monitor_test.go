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

	"tuxee/internal/monitor"
)

func TestMetricsAdmission(t *testing.T) {
	s := New(nil, nil, nil, "", fstest.MapFS{})
	request := httptest.NewRequest("GET", "http://tuxee.test/api/metrics", nil)
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != 401 {
		t.Fatalf("anonymous metrics: %d", response.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.logins[sha256.Sum256([]byte("metrics-token"))] = &login{ctx: ctx, cancel: cancel, expires: time.Now().Add(time.Hour)}
	request.AddCookie(&http.Cookie{Name: "tuxee_session", Value: "metrics-token"})
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	var value monitor.Snapshot
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &value) != nil || value.Time.IsZero() || value.Memory == nil || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("metrics: %d %s", response.Code, response.Body.String())
	}
	if len(value.Networks) == 0 || value.Networks[0].Name != monitor.AllNetworks {
		t.Fatalf("missing aggregate network: %+v", value.Networks)
	}
	request.Header.Set("Origin", "http://other.test")
	response = httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatalf("cross-origin metrics: %d", response.Code)
	}
}
func TestMonitoringPreferences(t *testing.T) {
	valid := func() *Monitoring {
		return &Monitoring{CPU: true, Memory: true, Disks: []string{"/"}, Networks: []string{monitor.AllNetworks, "eth0", "all"}, Interval: 2}
	}
	settings := Settings{Theme: "dark", Workspaces: []Workspace{}, Monitoring: valid()}
	if err := validateSettings(&settings); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Monitoring){
		func(m *Monitoring) { m.Interval = 1 }, func(m *Monitoring) { m.Disks = nil }, func(m *Monitoring) { m.Networks = nil },
		func(m *Monitoring) { m.Disks = []string{"relative"} }, func(m *Monitoring) { m.Disks = []string{"/a/../b"} },
		func(m *Monitoring) { m.Disks = []string{"/", "/"} }, func(m *Monitoring) { m.Disks = make([]string, 9) },
		func(m *Monitoring) { m.Networks = []string{"eth0", "eth0"} }, func(m *Monitoring) { m.Networks = []string{"../net"} },
		func(m *Monitoring) { m.Networks = []string{monitor.AllNetworks, monitor.AllNetworks} }, func(m *Monitoring) { m.Networks = []string{"/other"} },
		func(m *Monitoring) { m.Networks = []string{strings.Repeat("a", 16)} }, func(m *Monitoring) { m.Networks = []string{"bad\x00"} },
	} {
		settings.Monitoring = valid()
		change(settings.Monitoring)
		if validateSettings(&settings) == nil {
			t.Fatalf("accepted invalid preferences: %+v", settings.Monitoring)
		}
	}
	settings.Monitoring = nil
	if err := validateSettings(&settings); err != nil {
		t.Fatalf("old settings need no migration: %v", err)
	}
}
