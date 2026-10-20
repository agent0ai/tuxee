package update

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureBinary(version string) string { return "#!/bin/sh\nprintf 'Tuxee " + version + "\\n'\n" }

func TestVersionsAndReleaseValidation(t *testing.T) {
	for _, test := range []struct {
		latest, current string
		newer           bool
	}{
		{"v1.10.0", "1.9.0", true}, {"v1.0.0", "1.0.0", false},
		{"v1.0.0", "2.0.0", false}, {"v0.1.0", "0.1.0-poc", true},
		{"v1.0.0", "development", false}, {"v1.0.0-rc.1", "0.1.0", false},
	} {
		if got := Newer(test.latest, test.current); got != test.newer {
			t.Errorf("%+v: %v", test, got)
		}
	}
	for _, tag := range []string{"v1.2", "v01.2.3", "../x", "v1.2.3\n"} {
		if ValidTag(tag) {
			t.Fatal("accepted", tag)
		}
	}
	for _, body := range []string{
		`{"tag_name":"v1.2.3","draft":false,"prerelease":false}`,
		`{"tag_name":"v1.2.3","draft":true}`,
		`{"tag_name":"v1.2.3","prerelease":true}`, `{"tag_name":"../bad"}`, `{}`,
		`{"tag_name":"v1.2.3"} trailing`,
	} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
		c := &Client{http: s.Client(), latestURL: s.URL}
		_, err := c.Latest(context.Background())
		s.Close()
		if (err == nil) != strings.Contains(body, `"draft":false`) {
			t.Fatalf("%s: %v", body, err)
		}
	}
}

func TestApplyPreservesOldBinaryOnFailures(t *testing.T) {
	for _, mode := range []string{"valid", "bad checksum", "missing checksum", "duplicate checksum", "failed download", "truncated download", "wrong version", "not executable"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "tuxee")
			old := fixtureBinary("1.0.0")
			if err := os.WriteFile(path, []byte(old), 0755); err != nil {
				t.Fatal(err)
			}
			binary := fixtureBinary("1.1.0")
			if mode == "wrong version" {
				binary = fixtureBinary("9.0.0")
			}
			if mode == "not executable" {
				binary = "invalid executable"
			}
			name := "tuxee-linux-" + runtime.GOARCH
			sum := fmt.Sprintf("%x  %s\n", sha256.Sum256([]byte(binary)), name)
			switch mode {
			case "bad checksum":
				sum = strings.Repeat("0", 64) + "  " + name + "\n"
			case "missing checksum":
				sum = ""
			case "duplicate checksum":
				sum += sum
			}
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasPrefix(r.URL.Path, "/v1.1.0/") {
					t.Error("release was not pinned", r.URL.Path)
				}
				if strings.HasSuffix(r.URL.Path, "checksums.txt") {
					fmt.Fprint(w, sum)
					return
				}
				if mode == "failed download" {
					http.Error(w, "unavailable", 503)
					return
				}
				if mode == "truncated download" {
					w.Header().Set("Content-Length", "100000")
				}
				fmt.Fprint(w, binary)
			}))
			defer s.Close()
			c := &Client{http: s.Client(), downloadBase: s.URL + "/"}
			applied, err := c.Apply(context.Background(), Release{Tag: "v1.1.0"}, path)
			got, _ := os.ReadFile(path)
			if mode == "valid" {
				if err != nil || !applied || string(got) != binary {
					t.Fatalf("update: %v %v %q", applied, err, got)
				}
				info, _ := os.Stat(path)
				if info.Mode().Perm() != 0755 {
					t.Fatal("permissions", info.Mode())
				}
				if applied, err = c.Apply(context.Background(), Release{Tag: "v1.1.0"}, path); err != nil || applied {
					t.Fatalf("repeat: %v %v", applied, err)
				}
				if applied, err = c.Apply(context.Background(), Release{Tag: "v1.0.0"}, path); err != nil || applied {
					t.Fatalf("downgrade: %v %v", applied, err)
				}
			} else if err == nil || applied || string(got) != old {
				t.Fatalf("failure modified installation: %v %v %q", applied, err, got)
			}
			stages, _ := filepath.Glob(filepath.Join(dir, ".tuxee-stage-*"))
			if len(stages) != 0 {
				t.Fatal("leaked stages", stages)
			}
		})
	}
}

func TestInstallLockSymlinkAndCancellation(t *testing.T) {
	dir := t.TempDir()
	lock, err := LockDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	if other, err := LockDirectory(dir); err == nil {
		other.Close()
		t.Fatal("concurrent update allowed")
	}
	lock.Close()
	path := filepath.Join(dir, "tuxee")
	os.WriteFile(path, []byte(fixtureBinary("1.0.0")), 0755)
	link := filepath.Join(dir, "link")
	os.Symlink(path, link)
	if err = replace(context.Background(), link, "1.1.0", func(f *os.File) error { return nil }); err == nil {
		t.Fatal("replaced symlink directly")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = replace(ctx, path, "1.1.0", func(f *os.File) error { _, e := f.WriteString(fixtureBinary("1.1.0")); return e }); err == nil {
		t.Fatal("ignored cancellation")
	}
	got, _ := os.ReadFile(path)
	if string(got) != fixtureBinary("1.0.0") {
		t.Fatal("cancelled update replaced binary")
	}
}

func TestBootstrapCreatesLinkAndRefusesConflict(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	os.WriteFile(source, []byte(fixtureBinary("1.2.3")), 0755)
	target, command := filepath.Join(dir, "lib/tuxee"), filepath.Join(dir, "bin/tuxee")
	if err := bootstrap(context.Background(), source, target, command, "1.2.3"); err != nil {
		t.Fatal(err)
	}
	link, err := os.Readlink(command)
	if err != nil || link != target {
		t.Fatal(link, err)
	}
	dir2 := t.TempDir()
	conflict := filepath.Join(dir2, "tuxee")
	os.WriteFile(conflict, []byte("unrelated"), 0755)
	if err := bootstrap(context.Background(), source, filepath.Join(dir2, "lib/tuxee"), conflict, "1.2.3"); err == nil {
		t.Fatal("replaced unrelated command")
	}
	if _, err := os.Stat(filepath.Join(dir2, "lib/tuxee")); !os.IsNotExist(err) {
		t.Fatal("installed despite command conflict")
	}
}

func TestBootstrapReinstallsRealExecutable(t *testing.T) {
	source, err := filepath.Abs("../../bin/tuxee")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(source); os.IsNotExist(err) {
		t.Skip("build bin/tuxee for native bootstrap verification")
	}
	version, err := InstalledVersion(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	target, command := filepath.Join(dir, "lib/tuxee"), filepath.Join(dir, "bin/tuxee")
	for range 2 {
		if err := bootstrap(context.Background(), source, target, command, version); err != nil {
			t.Fatal(err)
		}
		if got, err := InstalledVersion(context.Background(), command); err != nil || got != version {
			t.Fatal(got, err)
		}
	}
}

func TestCheckCoalescingFailureAndDailySchedule(t *testing.T) {
	c := NewChecker("1.0.0")
	var calls atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	c.fetch = func(context.Context) (Release, error) {
		calls.Add(1)
		close(started)
		<-release
		return Release{Tag: "v1.1.0"}, nil
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() { c.Check(context.Background()) })
	}
	<-started
	close(release)
	wg.Wait()
	if calls.Load() != 1 || !c.Status().Available {
		t.Fatal(calls.Load(), c.Status())
	}
	c.mu.Lock()
	c.attempt = time.Time{}
	c.mu.Unlock()
	c.fetch = func(context.Context) (Release, error) { return Release{}, errors.New("offline") }
	status := c.Check(context.Background())
	if !status.Available || status.Latest != "v1.1.0" || status.Error != "offline" {
		t.Fatal(status)
	}
	c.Check(context.Background())
	for _, zone := range []string{"UTC", "America/New_York"} {
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range []string{"2026-03-08T00:02:00", "2026-03-08T23:59:59", "2026-11-01T00:02:00", "2026-11-01T00:00:00"} {
			now, _ := time.ParseInLocation("2006-01-02T15:04:05", value, loc)
			next := nextCheck(now)
			if !next.After(now) || next.Hour() != 0 || next.Minute() != 1 {
				t.Fatalf("%s -> %s", now, next)
			}
			if now.Minute() != 0 && next.Day() == now.Day() {
				t.Fatal("did not advance calendar day", now, next)
			}
		}
	}
}
