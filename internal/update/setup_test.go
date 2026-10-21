package update

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSetupRunsOnceAndSkipsNewContainers(t *testing.T) {
	for _, test := range []struct {
		name, completed, version string
		runs                     bool
	}{
		{"legacy container", "", "0.2.1", true},
		{"upgrade", "0.2.0", "0.2.1", true},
		{"fresh image", "0.2.1", "0.2.1", false},
		{"rollback", "0.3.0", "0.2.1", false},
		{"development", "", "0.0.0", false},
		{"invalid", "", "0.2.1; exit 1", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			marker := filepath.Join(dir, "update-version")
			if test.completed != "" {
				if err := os.WriteFile(marker, []byte(test.completed+"\n"), 0644); err != nil {
					t.Fatal(err)
				}
			}
			var output bytes.Buffer
			script := `printf 'ran %s\n' "$1"`
			for range 2 {
				if err := setup(context.Background(), test.version, dir, script, &output); err != nil {
					t.Fatal(err)
				}
			}
			want := 0
			if test.runs {
				want = 1
				data, err := os.ReadFile(marker)
				if err != nil || string(data) != test.version+"\n" {
					t.Fatalf("completion marker: %q, %v", data, err)
				}
			}
			if got := strings.Count(output.String(), "ran "); got != want {
				t.Fatalf("script ran %d times, want %d: %s", got, want, &output)
			}
		})
	}
}

func TestSetupFailureRetriesWithoutAdvancingMarker(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "update-version")
	if err := os.WriteFile(marker, []byte("0.2.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := setup(context.Background(), "0.2.1", dir, "echo failed; exit 1", &output); err == nil {
		t.Fatal("accepted failed setup")
	}
	data, err := os.ReadFile(marker)
	if err != nil || string(data) != "0.2.0\n" {
		t.Fatalf("failed setup changed marker: %q, %v", data, err)
	}
	if err := setup(context.Background(), "0.2.1", dir, "echo retried", &output); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(marker)
	if err != nil || string(data) != "0.2.1\n" || !strings.Contains(output.String(), "retried") {
		t.Fatalf("retry failed: %q, %v, %s", data, err, &output)
	}
}

func TestSetupCancellationStopsChildrenWithoutMarkingSuccess(t *testing.T) {
	dir := t.TempDir()
	temporary := t.TempDir()
	t.Setenv("TMPDIR", temporary)
	started := filepath.Join(dir, "started")
	finished := filepath.Join(dir, "finished")
	script := fmt.Sprintf("(sleep 0.5; touch %q) &\ntouch %q\nwait", finished, started)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- setup(ctx, "0.2.1", dir, script, &bytes.Buffer{}) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("script did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled setup succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled setup did not stop")
	}
	time.Sleep(600 * time.Millisecond)
	for _, path := range []string{finished, filepath.Join(dir, "update-version")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("cancelled setup left %s: %v", path, err)
		}
	}
	if files, err := os.ReadDir(temporary); err != nil || len(files) != 0 {
		t.Fatalf("cancelled setup left temporary files: %v, %v", files, err)
	}
}
