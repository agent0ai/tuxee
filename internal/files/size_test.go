package files

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSizeMixedSelectionsAndLinks(t *testing.T) {
	dir := t.TempDir()
	folder := filepath.Join(dir, "folder")
	if err := os.MkdirAll(filepath.Join(folder, "empty"), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(folder, "sparse"))
	if err != nil {
		t.Fatal(err)
	}
	const length = 5 << 30
	err = file.Truncate(length)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "other"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(".", filepath.Join(folder, "cycle")); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink("missing", filepath.Join(folder, "broken")); err != nil {
		t.Fatal(err)
	}
	var final SizeProgress
	err = calculateSize(context.Background(), []string{folder, folder, filepath.Join(folder, "sparse"), filepath.Join(dir, "other")}, func(p SizeProgress) error { final = p; return nil })
	if err != nil || !final.Done || final.Size != length+5+1+7 || final.Skipped != 0 {
		t.Fatalf("mixed selections: %+v, %v", final, err)
	}
	err = calculateSize(context.Background(), []string{filepath.Join(folder, "empty")}, func(p SizeProgress) error { final = p; return nil })
	if err != nil || !final.Done || final.Size != 0 {
		t.Fatalf("empty folder: %+v, %v", final, err)
	}
}

func TestSizeProgressCancellationAndPartial(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "source")
	if err := os.WriteFile(file, []byte("abc"), 0600); err != nil {
		t.Fatal(err)
	}
	for i := range 8192 {
		if err := os.Link(file, filepath.Join(dir, fmt.Sprint(i))); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := 0
	start := time.Now()
	err := calculateSize(ctx, []string{dir}, func(p SizeProgress) error {
		updates++
		if updates > 1 {
			if time.Since(start) < 500*time.Millisecond || p.Size == 0 || p.Done {
				t.Fatalf("unexpected intermediate update: %+v", p)
			}
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) || updates != 2 {
		t.Fatalf("cancel: %v, updates=%d", err, updates)
	}
	var final SizeProgress
	err = calculateSize(context.Background(), []string{dir, filepath.Join(t.TempDir(), "missing")}, func(p SizeProgress) error { final = p; return nil })
	if err != nil || !final.Done || final.Skipped != 1 || final.Size != 8193*3 {
		t.Fatalf("partial size: %+v, %v", final, err)
	}
	if os.Geteuid() != 0 {
		if err := os.Chmod(dir, 0000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
		err = calculateSize(context.Background(), []string{dir}, func(p SizeProgress) error { final = p; return nil })
		if err != nil || final.Skipped != 1 || final.Size != 0 || !final.Done {
			t.Fatalf("permission failure: %+v, %v", final, err)
		}
	}
}
