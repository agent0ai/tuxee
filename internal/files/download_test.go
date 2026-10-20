package files

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadZIPSelection(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".config", "empty"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{".config/settings": "settings", "literal*.txt": "literal", "unselected": "private"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("../unselected", filepath.Join(dir, ".config", "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(dir, ".config"), 0500); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	request := Request{Path: dir, Paths: []string{filepath.Join(dir, ".config"), filepath.Join(dir, "literal*.txt")}}
	if err := downloadZIP(context.Background(), request, &output); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]string{}
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		found[file.Name] = string(data)
		if file.Name == ".config/link" && file.Mode()&os.ModeSymlink == 0 {
			t.Fatal("symlink was followed instead of preserved")
		}
	}
	if len(found) != 5 || found[".config/settings"] != "settings" || found["literal*.txt"] != "literal" || found[".config/link"] != "../unselected" {
		t.Fatalf("wrong ZIP selection: %v", found)
	}
	if _, ok := found[".config/empty/"]; !ok {
		t.Fatal("empty folder missing")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 {
		t.Fatal("download left an archive or staging file")
	}
}

type cancelZIPWriter struct {
	bytes.Buffer
	cancel context.CancelFunc
}

func (w *cancelZIPWriter) Write(p []byte) (int, error) {
	n, err := w.Buffer.Write(p)
	w.cancel()
	return n, err
}

func TestDownloadZIPStreamsAndCancels(t *testing.T) {
	dir := t.TempDir()
	data := make([]byte, 2<<20)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "large")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &cancelZIPWriter{cancel: cancel}
	err := downloadZIP(ctx, Request{Path: dir, Paths: []string{path}}, output)
	if !errors.Is(err, context.Canceled) || output.Len() == 0 || output.Len() >= len(data) {
		t.Fatalf("did not stream before cancellation: size=%d err=%v", output.Len(), err)
	}
	if _, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); err == nil {
		t.Fatal("cancelled ZIP was finalized as a successful partial archive")
	}
}

func TestDownloadZIPRejectsInvalidSelections(t *testing.T) {
	for _, request := range []Request{
		{Path: "/tmp"}, {Path: "relative", Paths: []string{"/tmp/file"}},
		{Path: "/tmp", Paths: []string{"/etc/passwd"}},
		{Path: "/tmp", Paths: []string{"/tmp"}},
		{Path: "/tmp", Paths: []string{"/tmp/file", "/tmp/file"}},
	} {
		if ValidateDownload(request) == nil {
			t.Fatalf("accepted invalid selection: %+v", request)
		}
	}
}
