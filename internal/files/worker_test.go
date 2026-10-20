package files

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestUploadCollisionAndInterruption(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	if _, err := upload(context.Background(), path, strings.NewReader("short"), 20, false); err == nil {
		t.Fatal("accepted incomplete upload")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("incomplete upload published")
	}
	if _, err := upload(context.Background(), path, strings.NewReader("original"), 8, false); err != nil {
		t.Fatal(err)
	}
	if _, err := upload(context.Background(), path, strings.NewReader("replacement"), 11, false); err == nil {
		t.Fatal("overwrote collision")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "original" {
		t.Fatal("original changed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := upload(ctx, filepath.Join(dir, "cancelled"), strings.NewReader("data"), 4, true); err == nil {
		t.Fatal("cancelled upload succeeded")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("left staging files: %v", entries)
	}
}

func TestCopyTreeSymlinksAndCollisions(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "source")
	dst := filepath.Join(dir, "destination")
	if err := os.Mkdir(src, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "file"), []byte("contents"), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".", filepath.Join(src, "loop")); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(context.Background(), src, dst); err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(filepath.Join(dst, "loop")); err != nil || target != "." {
		t.Fatal("did not preserve symlink")
	}
	if err := copyTree(context.Background(), src, dst); err == nil {
		t.Fatal("copy overwrote destination")
	}
	if err := copyTree(context.Background(), src, filepath.Join(src, "nested")); err == nil {
		t.Fatal("copy recursed into itself")
	}
	if data, err := os.ReadFile(filepath.Join(src, "file")); err != nil || string(data) != "contents" {
		t.Fatal("source changed")
	}
}

func TestSameDirectoryCopy(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(source, []byte("original"), 0640); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"file (copy).txt", "file (copy 2).txt"} {
		result, _, err := execute(context.Background(), Request{Operation: "copy", Path: source, Destination: source}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if result.Path != filepath.Join(dir, name) {
			t.Fatal(result.Path)
		}
		if data, err := os.ReadFile(result.Path); err != nil || string(data) != "original" {
			t.Fatal("bad copy", err)
		}
	}
	if _, _, err := execute(context.Background(), Request{Operation: "copy", Path: source, Destination: filepath.Join(dir, "file (copy).txt")}, nil); err == nil {
		t.Fatal("overwrote explicit destination")
	}
	folder := filepath.Join(dir, "folder")
	if err := os.Mkdir(folder, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../file.txt", filepath.Join(folder, "link")); err != nil {
		t.Fatal(err)
	}
	result, _, err := execute(context.Background(), Request{Operation: "copy", Path: folder, Destination: folder}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(filepath.Join(result.Path, "link")); err != nil || target != "../file.txt" {
		t.Fatal("lost symlink", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := duplicate(ctx, source); err == nil {
		t.Fatal("ignored cancellation")
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tuxee-") {
			t.Fatal("left staging data")
		}
	}
}

func TestUniqueUploads(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	for _, name := range []string{"file.txt", ".env", "folder", "link"} {
		path := filepath.Join(dir, name)
		if name == "folder" {
			if err := os.Mkdir(path, 0700); err != nil {
				t.Fatal(err)
			}
		} else if name == "link" {
			if err := os.Symlink("file.txt", path); err != nil {
				t.Fatal(err)
			}
		} else if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
			t.Fatal(err)
		}
		for i := 1; i <= 2; i++ {
			result, _, err := execute(ctx, Request{Operation: "upload", Path: path, Size: 4, Unique: true}, strings.NewReader("copy"))
			want := fmt.Sprintf("%s (%d)", name, i)
			if name == "file.txt" {
				want = fmt.Sprintf("file (%d).txt", i)
			}
			if err != nil || result.Path != filepath.Join(dir, want) {
				t.Fatalf("%s: %s %v", name, result.Path, err)
			}
			if data, err := os.ReadFile(result.Path); err != nil || string(data) != "copy" {
				t.Fatalf("bad contents: %s %v", data, err)
			}
		}
	}
	if data, err := os.ReadFile(filepath.Join(dir, "link")); err != nil || string(data) != "original" {
		t.Fatal("overwrote symlink target", err)
	}
	if _, err := upload(ctx, filepath.Join(dir, "file.txt"), strings.NewReader("short"), 50, true); err == nil {
		t.Fatal("accepted incomplete unique upload")
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, ".tuxee-*"))
	if len(leftovers) != 0 {
		t.Fatal(leftovers)
	}
}

func TestConcurrentUniqueUploads(t *testing.T) {
	dir := t.TempDir()
	var group sync.WaitGroup
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			content := fmt.Sprintf("upload-%d", i)
			path, err := upload(context.Background(), filepath.Join(dir, "same.txt"), strings.NewReader(content), int64(len(content)), true)
			if err != nil {
				t.Error(err)
				return
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != content {
				t.Errorf("lost upload: %s %v", path, err)
			}
		}(i)
	}
	group.Wait()
	entries, _ := os.ReadDir(dir)
	if len(entries) != 12 {
		t.Fatalf("lost uploads or staging files: %v", entries)
	}
}

func TestUploadDirectories(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "uploads")
	for i := 0; i < 2; i++ {
		if _, _, err := execute(ctx, Request{Operation: "mkdir", Path: path, Parents: true}, nil); err != nil {
			t.Fatal(err)
		}
	}
	result, _, err := execute(ctx, Request{Operation: "mkdir", Path: path, Unique: true}, nil)
	if err != nil || result.Path != path+" (1)" {
		t.Fatal(result, err)
	}
	if _, _, err := execute(ctx, Request{Operation: "mkdir", Path: path}, nil); err == nil {
		t.Fatal("explicit mkdir accepted collision")
	}
	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := execute(ctx, Request{Operation: "mkdir", Path: file, Parents: true}, nil); err == nil {
		t.Fatal("used file as uploads folder")
	}
}
